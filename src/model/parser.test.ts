import { parseBpmnXml } from './parser';

const SIMPLE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:serviceTask id="Task_A" name="A"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_A"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_A" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;

describe('parseBpmnXml', () => {
  it('parses simple linear flow', async () => {
    const graph = await parseBpmnXml(SIMPLE_BPMN);
    expect(graph.processId).toBe('Process_1');
    expect(graph.startNodeIds).toContain('Start_1');
    expect(graph.nodes['Start_1']?.type).toBe('startEvent');
    expect(graph.nodes['Task_A']?.type).toBe('serviceTask');
    expect(graph.nodes['End_1']?.type).toBe('endEvent');
    expect(graph.flows['Flow_1']?.sourceRef).toBe('Start_1');
    expect(graph.flows['Flow_1']?.targetRef).toBe('Task_A');
    expect(graph.flows['Flow_2']?.sourceRef).toBe('Task_A');
    expect(graph.flows['Flow_2']?.targetRef).toBe('End_1');
    expect(graph.metadata.outgoingByNode['Start_1']).toContain('Flow_1');
    expect(graph.metadata.incomingByNode['Task_A']).toContain('Flow_1');
  });

  it('throws when no process found', async () => {
    const empty = `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"/>`;
    await expect(parseBpmnXml(empty)).rejects.toThrow('No process found');
  });

  it('parses tri:parameterOverwrites into extensions', async () => {
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://tri.com/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:serviceTask id="Task_P" name="Process" tri:parameterOverwrites="override-config"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_P"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_P" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;
    const graph = await parseBpmnXml(bpmn);
    expect(graph.nodes['Task_P']?.extensions?.['tri:parameterOverwrites']).toBe('override-config');
  });

  it('parses tri:multiInstanceData into multiInstance', async () => {
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://tri.com/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:serviceTask id="Task_MI" name="Process Items" tri:multiInstanceData="processList"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_MI"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_MI" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;
    const graph = await parseBpmnXml(bpmn);
    expect(graph.nodes['Task_MI']?.multiInstance).toEqual({ data: 'processList' });
    expect(graph.nodes['Task_MI']?.extensions?.['tri:multiInstanceData']).toBe('processList');
  });

  it('parses tri:condition on sequenceFlow into conditionExpression', async () => {
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://tri.com/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:exclusiveGateway id="Gw_1"/>
    <bpmn:endEvent id="End_A"/>
    <bpmn:endEvent id="End_B"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Gw_1"/>
    <bpmn:sequenceFlow id="Flow_cond" sourceRef="Gw_1" targetRef="End_A" tri:condition="Mittlere Temperatur &#60; 23 Grad&#10;"/>
    <bpmn:sequenceFlow id="Flow_default" sourceRef="Gw_1" targetRef="End_B" tri:condition=""/>
  </bpmn:process>
</bpmn:definitions>`;
    const graph = await parseBpmnXml(bpmn);
    expect(graph.flows['Flow_cond']?.conditionExpression).toBe('Mittlere Temperatur < 23 Grad\n');
    expect(graph.flows['Flow_default']?.conditionExpression).toBeUndefined();
  });

  it('nested bpmn:conditionExpression overrides tri:condition on same flow', async () => {
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://tri.com/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="End_1" tri:condition="from tri">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression"><![CDATA[from nested]]></bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;
    const graph = await parseBpmnXml(bpmn);
    expect(graph.flows['Flow_1']?.conditionExpression).toBe('from nested');
  });

  it('parses tri:roleId from lanes', async () => {
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:tri="http://example.com/tri">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_A" name="LaneA" tri:roleId="69a2b13a0c2ab7b7568a8f7a">
        <bpmn:flowNodeRef>Task_A</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_B" name="LaneB" tri:roleId="role-b">
        <bpmn:flowNodeRef>Task_B</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start_1"/>
    <bpmn:userTask id="Task_A" name="A"/>
    <bpmn:userTask id="Task_B" name="B"/>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_A"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_A" targetRef="Task_B"/>
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_B" targetRef="End_1"/>
  </bpmn:process>
</bpmn:definitions>`;
    const graph = await parseBpmnXml(bpmn);
    expect(graph.nodes['Task_A']?.laneRef).toBe('LaneA');
    expect(graph.nodes['Task_A']?.roleId).toBe('69a2b13a0c2ab7b7568a8f7a');
    expect(graph.nodes['Task_B']?.laneRef).toBe('LaneB');
    expect(graph.nodes['Task_B']?.roleId).toBe('role-b');
  });
});
