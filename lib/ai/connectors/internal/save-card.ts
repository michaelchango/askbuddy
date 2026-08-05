// 内部连接器：将抽取到的部分卡片增量合并写回需求。
import type { Connector, ConnectorInput } from "../types";
import type { RequirementCardData } from "../../types";
import { mergeRequirementCard } from "@/lib/services/requirements";

export const saveCardConnector: Connector<Partial<RequirementCardData>> = {
  name: "save-card",
  kind: "internal",
  async execute(input: ConnectorInput<Partial<RequirementCardData>>) {
    if (input.data && Object.keys(input.data).length > 0) {
      await mergeRequirementCard(input.requirementId, input.data);
    }
  },
};
