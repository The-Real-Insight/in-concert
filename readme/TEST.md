# BPMN Conformance Test Matrix

All BPMN models are located under:

    test/bpmn/

Each test defines:

- Model file
- Scenario
- Stimulus
- Expected engine behavior
- Key assertions

---

| Test ID | Model File | Scenario | Stimulus | Expected Behavior | Key Assertions |
|----------|------------|----------|----------|------------------|----------------|
| T01 | test/bpmn/linear.bpmn | Simple linear flow | Start → complete Task_A | Instance completes | 1 work item created; TOKEN_CREATED once per step; INSTANCE_COMPLETED emitted |
| T02 | test/bpmn/xor-split-with-default.bpmn | XOR branch selected | Decision returns Flow_A | Task_A created; Task_B not created | DECISION_REQUESTED emitted; exactly 1 TOKEN_CREATED after decision |
| T03 | test/bpmn/xor-split-with-default.bpmn | XOR default branch | Decision returns empty | Task_B created | Default flow taken; no failure |
| T04 | test/bpmn/and-split-join.bpmn | Parallel split/join | Complete only Task_A | Instance remains RUNNING | Join does not fire until both complete |
| T05 | test/bpmn/and-split-join.bpmn | Parallel join fires | Complete Task_A and Task_B | Instance completes | Join consumes 2 tokens; produces 1 outgoing token |
| T06 | test/bpmn/or-split-join.bpmn | OR single branch | Decision selects Flow_A only | Only Task_A created | Join fires after Task_A; does not wait for B |
| T07 | test/bpmn/or-split-join.bpmn | OR multiple branches | Decision selects Flow_A and Flow_B | Both tasks created | Join waits for both tokens with same activationId |
| T08 | test/bpmn/intermediate-timer.bpmn | Intermediate timer fires | Advance time beyond duration | Instance completes | TIMER_SCHEDULED and TIMER_FIRED emitted |
| T09 | test/bpmn/boundary-timer-interrupting.bpmn | Interrupting timer | Let timer fire before completion | Task_A canceled; escalation path taken | WORK_ITEM_CANCELED; BOUNDARY_TRIGGERED emitted |
| T10 | test/bpmn/boundary-timer-interrupting.bpmn | Normal completion before timer | Complete Task_A before dueAt | Normal path to end | Timer firing becomes no-op |
| T11 | test/bpmn/boundary-error-on-task.bpmn | Boundary error triggered | Complete Task_A with error code MyError | Error handler task created | WORK_ITEM_FAILED; BOUNDARY_TRIGGERED; no normal flow |
| T12 | test/bpmn/boundary-error-on-task.bpmn | No error | Complete Task_A normally | Normal flow to end | No boundary triggered |
| T13 | test/bpmn/message-catch.bpmn | Message resumes token | Publish matching message | Task_A created | MESSAGE_SUBSCRIBED and MESSAGE_RECEIVED emitted |
| T14 | test/bpmn/message-catch.bpmn | Non-matching message | Publish different message | No state change | No TOKEN_CREATED |
| T15 | test/bpmn/message-throw.bpmn | Message throw | Run process | CALLBACK_EVENT created | Outbox entry created; instance completes |
| T16 | test/bpmn/subprocess.bpmn | Embedded subprocess | Complete inner task | Scope ends; process completes | SCOPE_CREATED and SCOPE_ENDED emitted |
| T17 | any model | Duplicate work completion | Submit same completion twice | Idempotent response | No duplicate TOKEN_CREATED |
| T18 | any decision model | Duplicate decision | Submit same decision twice | Idempotent | No duplicate tokens |
| T19 | any model | Worker crash recovery | Simulate lease expiry | Continuation retried | No duplicate events |
| T20 | any callback model | Outbox duplicate delivery | Simulate dispatcher crash | Receiver dedupes | No duplicate state changes |

## Determinism Checks (All Tests)

For every test:

- Event seq must be strictly monotonic.
- Replay of process_instance_events must reconstruct identical state.
- No duplicate tokens.
- No duplicate joins.
- No duplicate work items.
- No duplicate decisions applied.

## Event-Level Assertions

| Test ID | Must Emit | Must Not Emit |
|----------|------------|---------------|
| T02 | DECISION_REQUESTED, DECISION_RECORDED | INSTANCE_FAILED |
| T09 | TIMER_FIRED, WORK_ITEM_CANCELED | TOKEN_CREATED on normal flow |
| T11 | WORK_ITEM_FAILED, BOUNDARY_TRIGGERED | TOKEN_CREATED on Flow_Normal |

## Calbacks 

Use moch callbacks with log output

## Test Tooling

Use jest

## Module Tests

Should sit under test/scripts
