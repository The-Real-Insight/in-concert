declare module 'bpmn-moddle' {
  interface BpmnModdle {
    fromXML(xml: string): Promise<{ rootElement: unknown }>;
  }
  const BpmnModdle: new () => BpmnModdle;
  export default BpmnModdle;
}
