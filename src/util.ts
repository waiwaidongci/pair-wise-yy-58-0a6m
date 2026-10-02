/** 响应式状态是 Proxy，structuredClone 无法处理；业务数据均为 JSON 可序列化结构 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
