"use client";
import { SWRConfig } from "swr";

/**
 * 全局 SWR 配置：关闭「窗口聚焦 / 网络重连」自动重验证。
 *
 * 理由：默认 revalidateOnFocus=true 会在用户切回标签页时对所有 SWR key 重新请求，
 * 详情页的 req / project / siblings 本就存在串行 waterfall，加上列表页全量需求拉取，
 * 切回标签即触发一波冗余重拉，体感很卡。所有写后更新都走显式 mutate（带缓存注入），
 * 关闭聚焦重验不影响数据正确性，却能显著减少无谓请求。
 * 个别需要保留默认行为的 hook 仍可在自身 options 里覆盖。
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        dedupingInterval: 5000,
        focusThrottleInterval: 10000,
      }}
    >
      {children}
    </SWRConfig>
  );
}
