const { KafkaJSNonRetriableError } = require('../errors')
const COORDINATOR_TYPES = require('../protocol/coordinatorTypes')
const { EventEmitter } = require('events')

const NO_PRODUCER_ID = -1
const SEQUENCE_START = 0
const INT_32_MAX_VALUE = Math.pow(2, 32)

const STATES = {
  UNINITIALIZED: 'UNINITIALIZED',
  READY: 'READY',
  TRANSACTING: 'TRANSACTING',
  COMMITTING: 'COMMITTING',
  ABORTING: 'COMMITTING',
}

const VALID_TRANSITIONS = {
  [STATES.UNINITIALIZED]: [STATES.READY],
  [STATES.READY]: [STATES.READY, STATES.TRANSACTING],
  [STATES.TRANSACTING]: [STATES.COMMITTING, STATES.ABORTING],
  [STATES.COMMITTING]: [STATES.READY],
  [STATES.ABORTING]: [STATES.READY],
}

/**
 * Manage behavior for an idempotent producer and transactions.
 */
module.exports = ({
  logger,
  cluster,
  transactionTimeout = 60000,
  transactional,
  transactionalId,
}) => {
  if (transactional && !transactionalId) {
    throw new KafkaJSNonRetriableError('Cannot manage transactions without a transactionalId')
  }

  /**
   * Current producer ID
   */
  let producerId = NO_PRODUCER_ID

  /**
   * Current producer epoch
   */
  let producerEpoch = 0

  /**
   * Idempotent production requires that the producer track the sequence number of messages.
   *
   * Sequences are sent with every Record Batch and tracked per Topic-Partition
   */
  let producerSequence = {}

  /**
   * Topic partitions already participating in the transaction
   */
  let transactionTopicPartitions = {}

  /**
   * Current state in the transactional producer lifecycle
   */
  let currentState = STATES.UNINITIALIZED

  const stateMachine = Object.assign(new EventEmitter(), {
    /**
     * Ensure state machine is in the correct state before calling method
     */
    guard(object, method, eligibleStates) {
      const fn = object.method

      object.method = (...args) => {
        if (!eligibleStates.includes(currentState)) {
          throw new KafkaJSNonRetriableError(
            `Transaction state exception: Cannot call "${method}" in state "${currentState}"`
          )
        }

        return fn.apply(object, args)
      }
    },
    /**
     * Transition safely to a new state
     */
    transitionTo(state) {
      logger.debug(`Transaction state transition ${currentState} --> ${state}`)

      if (!VALID_TRANSITIONS[currentState].includes(state)) {
        throw new KafkaJSNonRetriableError(
          `Transaction state exception: Invalid transition ${currentState} --> ${state}`
        )
      }

      stateMachine.emit('transition', { to: state, from: currentState })
      currentState = state
    },
  })

  stateMachine.on('transition', ({ to }) => {
    if (to === STATES.READY) {
      transactionTopicPartitions = {}
    }
  })

  const transactionalGuard = () => {
    if (!transactional) {
      throw new KafkaJSNonRetriableError('Method unavailable if non-transactional')
    }
  }

  const transactionManager = {
    /**
     * Get the current producer id
     * @returns {number}
     */
    getProducerId() {
      return producerId
    },

    /**
     * Get the current producer epoch
     * @returns {number}
     */
    getProducerEpoch() {
      return producerEpoch
    },

    getTransactionalId() {
      return transactionalId
    },

    /**
     * Initialize the idempotent producer by making an `InitProducerId` request.
     * Overwrites any existing state in this transaction manager
     */
    initProducerId: async () => {
      await cluster.refreshMetadataIfNecessary()

      // If non-transactional we can request the PID from any broker
      const broker = transactional
        ? await cluster.findGroupCoordinator({
            groupId: transactionalId,
            coordinatorType: COORDINATOR_TYPES.TRANSACTION,
          })
        : await cluster.findControllerBroker()

      const result = await broker.initProducerId({
        transactionalId: transactional ? transactionalId : undefined,
        transactionTimeout,
      })

      stateMachine.transitionTo(STATES.READY)
      producerId = result.producerId
      producerEpoch = result.producerEpoch
      producerSequence = {}

      logger.debug('Initialized producer id & epoch', { producerId, producerEpoch })
    },

    /**
     * Get the current sequence for a given Topic-Partition. Defaults to 0.
     *
     * @param {string} topic
     * @param {string} partition
     * @returns {number}
     */
    getSequence(topic, partition) {
      if (!transactionManager.isInitialized()) {
        return SEQUENCE_START
      }

      producerSequence[topic] = producerSequence[topic] || {}
      producerSequence[topic][partition] = producerSequence[topic][partition] || SEQUENCE_START

      return producerSequence[topic][partition]
    },

    /**
     * Update the sequence for a given Topic-Partition.
     *
     * Do nothing if not yet initialized (not idempotent)
     * @param {string} topic
     * @param {string} partition
     * @param {number} increment
     */
    updateSequence(topic, partition, increment) {
      if (!transactionManager.isInitialized()) {
        return
      }

      const previous = transactionManager.getSequence(topic, partition)
      let sequence = previous + increment

      // Sequence is defined as Int32 in the Record Batch,
      // so theoretically should need to rotate here
      if (sequence >= INT_32_MAX_VALUE) {
        logger.debug(
          `Sequence for ${topic} ${partition} exceeds max value (${sequence}). Rotating to 0.`
        )
        sequence = 0
      }

      producerSequence[topic][partition] = sequence
    },

    /**
     * Begin a transaction
     */
    beginTransaction() {
      transactionalGuard()
      stateMachine.transitionTo(STATES.TRANSACTING)
    },

    /**
     * Add partitions to a transaction if they are not already marked as participating.
     *
     * Should be called prior to sending any messages during a transaction
     * @param {TopicData[]} topicData
     *
     * @typedef {Object} TopicData
     * @property {string} topic
     * @property {object[]} partitions
     * @property {number} partitions[].partition
     */
    async addPartitionsToTransaction(topicData) {
      transactionalGuard()
      const newTopicPartitions = {}

      topicData.forEach(({ topic, partitions }) => {
        transactionTopicPartitions[topic] = transactionTopicPartitions[topic] || {}

        partitions.forEach(({ partition }) => {
          if (!transactionTopicPartitions[topic][partition]) {
            newTopicPartitions[topic] = newTopicPartitions[topic] || []
            newTopicPartitions[topic].push(partition)
          }
        })
      })

      const topics = Object.keys(newTopicPartitions).map(topic => ({
        topic,
        partitions: newTopicPartitions[topic],
      }))

      if (topics.length) {
        const broker = await cluster.findGroupCoordinator({
          groupId: transactionalId,
          coordinatorType: COORDINATOR_TYPES.TRANSACTION,
        })
        await broker.addPartitionsToTxn({ transactionalId, producerId, producerEpoch, topics })
      }

      topics.forEach(({ topic, partitions }) => {
        partitions.forEach(partition => {
          transactionTopicPartitions[topic][partition] = true
        })
      })
    },

    /**
     * Commit the ongoing transaction
     */
    async commit() {
      transactionalGuard()
      stateMachine.transitionTo(STATES.COMMITTING)

      const broker = await cluster.findGroupCoordinator({
        groupId: transactionalId,
        coordinatorType: COORDINATOR_TYPES.TRANSACTION,
      })
      await broker.endTxn({ producerId, producerEpoch, transactionalId, transactionalResult: true })

      stateMachine.transitionTo(STATES.READY)
    },

    /**
     * Abort the ongoing transaction
     */
    async abort() {
      transactionalGuard()
      stateMachine.transitionTo(STATES.ABORTING)

      const broker = await cluster.findGroupCoordinator({
        groupId: transactionalId,
        coordinatorType: COORDINATOR_TYPES.TRANSACTION,
      })
      await broker.endTxn({
        producerId,
        producerEpoch,
        transactionalId,
        transactionalResult: false,
      })

      stateMachine.transitionTo(STATES.READY)
    },

    /**
     * Whether the producer id has already been initialized
     */
    isInitialized() {
      return producerId !== NO_PRODUCER_ID
    },

    isTransactional() {
      return transactional
    },

    isInTransaction() {
      return currentState === STATES.TRANSACTING
    },
  }

  // Enforce the state machine
  stateMachine.guard(transactionManager, 'initProducerId', [STATES.UNINITIALIZED, STATES.READY])
  stateMachine.guard(transactionManager, 'beginTransaction', [STATES.READY])
  stateMachine.guard(transactionManager, 'getSequence', [STATES.TRANSACTING])
  stateMachine.guard(transactionManager, 'updateSequence', [STATES.TRANSACTING])
  stateMachine.guard(transactionManager, 'addPartitionsToTransaction', [STATES.TRANSACTING])
  stateMachine.guard(transactionManager, 'commit', [STATES.TRANSACTING])
  stateMachine.guard(transactionManager, 'abort', [STATES.TRANSACTING])

  return transactionManager
}
