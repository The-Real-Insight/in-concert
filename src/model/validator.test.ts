import { validateBpmnXml } from './validator';

const BPMN_WITH_LANES_NO_ROLE_ID = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://tri.com/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_A" name="LaneA">
        <bpmn:flowNodeRef>Task_1</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_B" name="">
        <bpmn:flowNodeRef>Task_2</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_C" name="LaneC" tri:roleId="role-c">
        <bpmn:flowNodeRef>Task_3</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start_1"/>
    <bpmn:userTask id="Task_1" name="T1"/>
    <bpmn:userTask id="Task_2" name="T2"/>
    <bpmn:userTask id="Task_3" name="T3"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="Task_1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="Task_1" targetRef="Task_2"/>
    <bpmn:sequenceFlow id="F3" sourceRef="Task_2" targetRef="Task_3"/>
    <bpmn:sequenceFlow id="F4" sourceRef="Task_3" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;

const BPMN_VALID_LANES = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://tri.com/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_A" name="LaneA" tri:roleId="role-a">
        <bpmn:flowNodeRef>Task_1</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_B" name="LaneB" tri:roleId="role-b">
        <bpmn:flowNodeRef>Task_2</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start_1"/>
    <bpmn:userTask id="Task_1" name="T1"/>
    <bpmn:userTask id="Task_2" name="T2"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="Task_1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="Task_1" targetRef="Task_2"/>
    <bpmn:sequenceFlow id="F3" sourceRef="Task_2" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;

const BPMN_WITH_POOL_NO_ROLE_ID = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://tri.com/schema/bpmn">
  <bpmn:collaboration id="Collab_1">
    <bpmn:participant id="Participant_1" name="Org" processRef="Process_1"/>
    <bpmn:participant id="Participant_2" name="" tri:roleId="role-2" processRef="Process_2"/>
  </bpmn:collaboration>
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="End_1"/>
  </bpmn:process>
  <bpmn:process id="Process_2" isExecutable="true">
    <bpmn:startEvent id="Start_2"/>
    <bpmn:endEvent id="End_2"/>
    <bpmn:sequenceFlow id="F2" sourceRef="Start_2" targetRef="End_2"/>
  </bpmn:process>
</bpmn:definitions>`;

describe('validateBpmnXml', () => {
  it('reports lanes missing name or tri:roleId', async () => {
    const issues = await validateBpmnXml(BPMN_WITH_LANES_NO_ROLE_ID);
    const laneIssues = issues.filter((i) => i.elementType === 'lane');
    expect(laneIssues).toContainEqual(
      expect.objectContaining({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        elementId: 'Lane_A',
        message: expect.stringContaining('tri:roleId'),
      })
    );
    expect(laneIssues).toContainEqual(
      expect.objectContaining({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        elementId: 'Lane_B',
        message: expect.stringContaining('name'),
      })
    );
    expect(laneIssues).not.toContainEqual(
      expect.objectContaining({ elementId: 'Lane_C' })
    );
  });

  it('returns no pool/lane issues when lanes have name and tri:roleId', async () => {
    const issues = await validateBpmnXml(BPMN_VALID_LANES);
    const poolLaneIssues = issues.filter(
      (i) => i.rule === 'POOLS_AND_LANES_NAME_ROLE_ID'
    );
    expect(poolLaneIssues).toHaveLength(0);
  });

  it('reports pools missing name or tri:roleId', async () => {
    const issues = await validateBpmnXml(BPMN_WITH_POOL_NO_ROLE_ID);
    const poolIssues = issues.filter((i) => i.elementType === 'pool');
    expect(poolIssues).toContainEqual(
      expect.objectContaining({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        elementId: 'Participant_1',
        message: expect.stringContaining('tri:roleId'),
      })
    );
    expect(poolIssues).toContainEqual(
      expect.objectContaining({
        rule: 'POOLS_AND_LANES_NAME_ROLE_ID',
        elementId: 'Participant_2',
        message: expect.stringContaining('name'),
      })
    );
  });

  it('reports orphaned tasks (no incoming or outgoing flow)', async () => {
    const bpmnWithOrphan = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:userTask id="Task_1" name="Connected"/>
    <bpmn:userTask id="Task_Orphan" name="Orphan"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="Task_1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="Task_1" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;
    const issues = await validateBpmnXml(bpmnWithOrphan);
    const orphanIssues = issues.filter((i) => i.rule === 'NO_ORPHANED_NODES');
    expect(orphanIssues).toContainEqual(
      expect.objectContaining({
        elementId: 'Task_Orphan',
        message: expect.stringContaining('no incoming'),
      })
    );
    expect(orphanIssues).toContainEqual(
      expect.objectContaining({
        elementId: 'Task_Orphan',
        message: expect.stringContaining('no outgoing'),
      })
    );
  });
});
