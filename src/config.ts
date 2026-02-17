export const config = {
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017/tri-bpmn-engine',
  port: parseInt(process.env.PORT ?? '3000', 10),
};
