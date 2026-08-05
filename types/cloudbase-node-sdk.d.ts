// 环境声明：@cloudbase/node-sdk 未随包提供类型定义，这里仅声明用到的 init 入口。
// 运行期该包通过 module.exports.init 暴露，命名导入可正常工作。
declare module "@cloudbase/node-sdk" {
  // 初始化配置：env 必填；accessKey 用于服务端 ApiKey 鉴权，亦可传 secretId/secretKey。
  export function init(config?: Record<string, any>): any;
  const _default: { init: typeof init };
  export default _default;
}
