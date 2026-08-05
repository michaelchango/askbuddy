// 连接器统一抽象：内部（写回平台）/ 外部（MCP 对接设计工具）。
export interface ConnectorInput<T> {
  requirementId: string;
  data: T;
}

export interface Connector<T = unknown> {
  name: string;
  kind: "internal" | "external";
  execute(input: ConnectorInput<T>): Promise<void>;
}
