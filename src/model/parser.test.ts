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
});
