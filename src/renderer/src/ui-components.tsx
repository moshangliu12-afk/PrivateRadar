import type { ReactNode } from 'react'

const ICONS = {
  radar: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><path d="M12 3.5V12l5.7-5.7" /><circle cx="12" cy="12" r="1" /></>,
  topics: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="5" r="2" /><circle cx="15" cy="18" r="3" /><path d="m8.5 6 7.5-1M7.5 8.5l6 7M17.5 7l-1.5 8" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m10 3-.5 2-2 1-2-.5-2 3 1.5 1.5v3L3.5 15l2 3 2-.5 2 1 .5 2h4l.5-2 2-1 2 .5 2-3-1.5-1.5v-3L20.5 9l-2-3-2 .5-2-1L14 3Z" /></>,
  shield: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  inbox: <><path d="M5 5h14l2 12h-6l-1.5 2h-3L9 17H3L5 5Z" /><path d="M8 10h8M12 7v6m-2-2 2 2 2-2" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="M20 2v4M18 4h4" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  chat: <><path d="M20 11a8 8 0 0 1-8 8H6l-3 2 1-4A8 8 0 1 1 20 11Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  folder: <path d="M3 6h7l2 2h9v12H3V6Z" />,
  link: <><path d="m10 14 4-4M9 15l-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0M15 9l2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0" /></>
} satisfies Record<string, ReactNode>

export type UiIconName = keyof typeof ICONS

/** 图标只负责展示，不新增操作或产品状态。 */
export function UiIcon({ name, className = '' }: { name: UiIconName; className?: string }): React.JSX.Element {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[name]}</svg>
}

export function EmptySignal({ title, description, kicker = '今日信号安静', icon = 'spark' }: {
  title: string
  description: string
  kicker?: string
  icon?: UiIconName
}): React.JSX.Element {
  return <article className="empty-feature">
    <div className="empty-illustration" aria-hidden="true">
      <span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="orbit orbit-three" />
      <span className="orbit-core"><UiIcon name={icon} /></span><span className="orbit-node node-one" /><span className="orbit-node node-two" />
    </div>
    <div className="empty-copy"><div className="empty-kicker"><span className="status-dot" />{kicker}</div><h3>{title}</h3><p>{description}</p></div>
  </article>
}
