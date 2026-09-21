import { useEffect, useRef, useState } from 'react'
import type {
  CandidateEvidence,
  ChatQueryResponse,
  DailyBriefItem,
  DailyValue,
  DailyValueReasonCode,
  DailyReasonCode,
  DashboardSummary,
  FeedbackState,
  FirstUseStatus,
  ImportResult,
  LatestGuidedImport,
  MessageContext,
  TopicEvidence,
  TopicRadarItem,
  TopicRadarSummary,
  TopicReasonCode
} from '../../shared/models'
import { isCompletedDataImport, loadDaily, refreshAfterExternalImport, refreshSubmittedSearch, senderCountLabel } from './data-refresh'
import { canNavigateToNextDate, formatLocalDateKey, shiftLocalDateKey, shouldShowReturnToLatest } from './daily-date'

const NAV_ITEMS = ['今日情报', '话题雷达', '问我的聊天', '设置']

export function App(): React.JSX.Element {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [latestDate, setLatestDate] = useState<string | null>(null)
  const [dailyLoading, setDailyLoading] = useState(false)
  const [page, setPage] = useState<'welcome' | 'import-guide' | 'import-complete' | 'daily' | 'radar' | 'search' | 'settings'>('daily')
  const [firstUse, setFirstUse] = useState<FirstUseStatus | null>(null)
  const [bootstrapped, setBootstrapped] = useState(false)
  const [importBaselineJobId, setImportBaselineJobId] = useState<string | null>(null)
  const [radar, setRadar] = useState<TopicRadarSummary | null>(null)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [openCandidateId, setOpenCandidateId] = useState('')
  const [evidence, setEvidence] = useState<CandidateEvidence | null>(null)
  const [openTopicId, setOpenTopicId] = useState('')
  const [topicEvidence, setTopicEvidence] = useState<TopicEvidence | null>(null)
  const [question, setQuestion] = useState('')
  const [querying, setQuerying] = useState(false)
  const [queryResponse, setQueryResponse] = useState<ChatQueryResponse | null>(null)
  const [openMessageId, setOpenMessageId] = useState('')
  const [messageContext, setMessageContext] = useState<MessageContext | null>(null)
  const [dailyFeedback, setDailyFeedback] = useState<Record<string, FeedbackState>>({})
  const observedImportJobId = useRef<string | null | undefined>(undefined)
  const submittedQuestion = useRef('')

  useEffect(() => {
    Promise.all([window.privateRadar.getDashboardSummary(), window.privateRadar.getFirstUseStatus()])
      .then(([nextSummary, status]) => {
        setSummary(nextSummary)
        setSelectedDate(nextSummary.date)
        setLatestDate(nextSummary.date)
        setFirstUse(status)
        observedImportJobId.current = status.latestImport?.jobId ?? null
        if (status.firstLaunch) setPage('welcome')
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '无法读取本地数据'))
      .finally(() => setBootstrapped(true))
  }, [])

  useEffect(() => {
    if (!summary || summary.items.length === 0) {
      setDailyFeedback({})
      return
    }
    void window.privateRadar.getDailyFeedbackStates(summary.items.map((item) => item.candidateId))
      .then(setDailyFeedback)
      .catch(() => undefined)
  }, [summary])

  useEffect(() => {
    if (!bootstrapped) return
    let checking = false
    const timer = window.setInterval(() => {
      if (checking) return
      checking = true
      void window.privateRadar.getFirstUseStatus().then(async (status) => {
        const nextJobId = status.latestImport?.jobId ?? null
        const isNewJob = observedImportJobId.current !== undefined && nextJobId !== observedImportJobId.current
        observedImportJobId.current = nextJobId
        setFirstUse(status)
        if (isNewJob && isCompletedDataImport(status)) {
          const latest = await loadDaily(window.privateRadar)
          const staysOnLatest = selectedDate === null || selectedDate === latestDate
          const refreshed = await refreshAfterExternalImport(window.privateRadar, page === 'radar', staysOnLatest ? undefined : selectedDate)
          setSummary(refreshed.summary)
          setRadar(refreshed.radar)
          setLatestDate(latest.date)
          if (staysOnLatest) setSelectedDate(latest.date)
          const refreshedSearch = await refreshSubmittedSearch(window.privateRadar, submittedQuestion.current)
          if (refreshedSearch) setQueryResponse(refreshedSearch)
        }
        if (page === 'import-guide' && status.latestImport && status.latestImport.jobId !== importBaselineJobId) {
          setPage('import-complete')
        }
      }).catch(() => undefined).finally(() => { checking = false })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [bootstrapped, page, importBaselineJobId, latestDate, selectedDate])

  async function activateDemo(): Promise<void> {
    setError('')
    try {
      const nextSummary = await window.privateRadar.activateDemo()
      setSummary(nextSummary)
      setSelectedDate(nextSummary.date)
      setLatestDate(nextSummary.date)
      setFirstUse(await window.privateRadar.getFirstUseStatus())
      setPage('daily')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法载入演示数据')
    }
  }

  async function beginWechatImport(): Promise<void> {
    const status = await window.privateRadar.getFirstUseStatus()
    setFirstUse(status)
    setImportBaselineJobId(status.latestImport?.jobId ?? null)
    setPage('import-guide')
  }

  async function refreshFirstUse(): Promise<FirstUseStatus> {
    const status = await window.privateRadar.checkWorkBuddyConnection()
    setFirstUse(status)
    return status
  }

  async function chooseFile(): Promise<void> {
    setImporting(true)
    setError('')
    try {
      const result = await window.privateRadar.chooseAndImportFile()
      if (result) {
        setImportResult(result)
        const nextSummary = await window.privateRadar.getDashboardSummary()
        setSummary(nextSummary)
        setSelectedDate(nextSummary.date)
        setLatestDate(nextSummary.date)
        if (page === 'radar') setRadar(await window.privateRadar.getTopicRadarSummary())
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '文件导入失败')
    } finally {
      setImporting(false)
    }
  }

  async function openRadar(): Promise<void> {
    setPage('radar')
    setError('')
    try {
      setRadar(await window.privateRadar.getTopicRadarSummary())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法生成话题雷达')
    }
  }

  async function openDaily(): Promise<void> {
    setPage('daily')
    setError('')
    try {
      const nextSummary = await loadDaily(window.privateRadar)
      setSummary(nextSummary)
      setSelectedDate(nextSummary.date)
      setLatestDate(nextSummary.date)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法刷新今日情报')
    }
  }

  async function loadSelectedDate(date: string): Promise<void> {
    setDailyLoading(true)
    setError('')
    setOpenCandidateId('')
    setEvidence(null)
    try {
      setSummary(await loadDaily(window.privateRadar, date))
      setSelectedDate(date)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取当日情报')
    } finally {
      setDailyLoading(false)
    }
  }

  async function goToLatestDate(): Promise<void> {
    if (!latestDate) return
    setDailyLoading(true)
    setError('')
    setOpenCandidateId('')
    setEvidence(null)
    try {
      const nextSummary = await loadDaily(window.privateRadar)
      setSummary(nextSummary)
      setSelectedDate(nextSummary.date)
      setLatestDate(nextSummary.date)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取最新日期情报')
    } finally {
      setDailyLoading(false)
    }
  }

  async function toggleTopicEvidence(topicId: string, date: string): Promise<void> {
    if (openTopicId === topicId) {
      setOpenTopicId('')
      setTopicEvidence(null)
      return
    }
    setOpenTopicId(topicId)
    setTopicEvidence(await window.privateRadar.getTopicEvidence(topicId, date))
  }

  async function submitQuestion(value = question): Promise<void> {
    const nextQuestion = value.trim()
    if (!nextQuestion) return
    submittedQuestion.current = nextQuestion
    setQuestion(nextQuestion)
    setQuerying(true)
    setError('')
    setOpenMessageId('')
    setMessageContext(null)
    try {
      setQueryResponse(await window.privateRadar.askChat(nextQuestion))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '检索聊天失败')
    } finally {
      setQuerying(false)
    }
  }

  async function toggleMessageContext(messageId: string): Promise<void> {
    if (openMessageId === messageId) {
      setOpenMessageId('')
      setMessageContext(null)
      return
    }
    setOpenMessageId(messageId)
    setMessageContext(await window.privateRadar.getMessageContext(messageId))
  }

  async function toggleEvidence(candidateId: string): Promise<void> {
    if (openCandidateId === candidateId) {
      setOpenCandidateId('')
      setEvidence(null)
      return
    }
    setOpenCandidateId(candidateId)
    setEvidence(await window.privateRadar.getCandidateEvidence(candidateId))
  }

  async function saveDailyItemFeedback(item: DailyBriefItem, vote: 'USEFUL' | 'SHOULD_NOT_SHOW', reasonCode?: string | null, note?: string | null): Promise<void> {
    const state = await window.privateRadar.saveDailyFeedback({ item, vote, reasonCode, note })
    setDailyFeedback((current) => ({ ...current, [item.candidateId]: state }))
  }

  async function regenerate(): Promise<void> {
    setRegenerating(true)
    setError('')
    try {
      setSummary(await window.privateRadar.regenerateDashboard(selectedDate ?? undefined))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重新生成失败')
    } finally {
      setRegenerating(false)
    }
  }

  if (!bootstrapped) return <div className="first-use-loading">正在准备 PrivateRadar……</div>
  if (page === 'welcome') {
    return <WelcomePage error={error} onDemo={activateDemo} onImport={beginWechatImport} />
  }
  if (page === 'import-guide' && firstUse) {
    return <WechatImportGuide status={firstUse} onBack={() => setPage(firstUse.firstLaunch ? 'welcome' : 'daily')} onRefresh={refreshFirstUse} />
  }
  if (page === 'import-complete' && firstUse?.latestImport) {
    return <ImportCompletePage result={firstUse.latestImport} onRetry={beginWechatImport} onGo={(target) => target === 'radar' ? void openRadar() : target === 'daily' ? void openDaily() : setPage(target)} />
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">PR</span>
          <div><strong>PrivateRadar</strong><small>个人情报系统</small></div>
        </div>
        <nav>
          {NAV_ITEMS.map((item, index) => (
            <button
              className={(page === 'daily' && index === 0) || (page === 'radar' && index === 1) || (page === 'search' && index === 2) || (page === 'settings' && index === 3) ? 'active' : ''}
              key={item}
              type="button"
              onClick={index === 0 ? () => void openDaily() : index === 1 ? () => void openRadar() : index === 2 ? () => setPage('search') : () => { setPage('settings'); void refreshFirstUse() }}
            >
              <span>{['◉', '⌁', '⌕', '⚙'][index]}</span>{item}
            </button>
          ))}
        </nav>
        <div className="privacy-note">聊天原文仅保存在本机</div>
      </aside>

      <main>
        <header>
          <div>
            {page === 'daily' && selectedDate && latestDate
              ? <div className="daily-date-navigation">
                  <button type="button" aria-label="上一天" onClick={() => void loadSelectedDate(shiftLocalDateKey(selectedDate, -1))} disabled={dailyLoading}>‹</button>
                  <strong>{formatLocalDateKey(selectedDate)}</strong>
                  <button type="button" aria-label="下一天" onClick={() => void loadSelectedDate(shiftLocalDateKey(selectedDate, 1))} disabled={dailyLoading || !canNavigateToNextDate(selectedDate, latestDate)}>›</button>
                  {shouldShowReturnToLatest(selectedDate, latestDate) && <button className="return-latest-button" type="button" onClick={() => void goToLatestDate()} disabled={dailyLoading}>回到最新</button>}
                </div>
              : <div className="eyebrow">{page === 'settings' ? '数据与隐私' : (page === 'radar' ? radar?.date : summary?.date) ?? '正在读取日期'}</div>}
            <h1>{page === 'daily' ? '今日情报' : page === 'radar' ? '话题雷达' : page === 'search' ? '问我的聊天' : '设置'}</h1>
            <p>{page === 'daily' ? '从噪音里，找到今天真正值得看的信息。' : page === 'radar' ? '识别相对过去七天正在突然升温的跨群话题。' : page === 'search' ? '先检索本地证据，再基于证据回答。' : '查看数据来源、存储状态与隐私说明。'}</p>
          </div>
          <div className="header-actions">
            {page === 'daily' && summary && <span className={`mode-badge ${summary.mode}`}>{modeLabel(summary)}</span>}
            {summary?.demoMode && <span className="demo-badge">当前为演示数据</span>}
            {page === 'daily' && summary?.mode === 'ai' && <button className="regenerate-button" type="button" onClick={() => void regenerate()} disabled={regenerating || dailyLoading}>{regenerating ? '正在整理…' : '重新生成'}</button>}
            <button className="import-button" type="button" onClick={() => void beginWechatImport()}>
              开始导入我的聊天
            </button>
          </div>
        </header>

        {error && <div className="error">数据读取失败：{error}</div>}
        {!summary && !error && <div className="loading">正在读取本地消息……</div>}
        {page === 'daily' && summary && dailyLoading && <div className="loading">正在读取当日聊天……</div>}

        {importResult && <ImportReport result={importResult} />}

        {page === 'daily' && summary && !dailyLoading && (
          <>
            <section className="stats">
              <Stat label="当日分析群" value={summary.conversationCount} suffix="个" />
              <Stat label="当日消息" value={summary.messageCount} suffix="条" />
              <Stat label="当日情报" value={summary.finalIntelligenceCount} suffix="条" />
              <div className="stat mode-stat"><span>当前模式</span><strong>{modeLabel(summary)}</strong></div>
            </section>

            {summary.modeNotice && <div className="mode-notice">{summary.modeNotice}</div>}
            {summary.mode === 'ai' && summary.telemetry && (
              <div className="privacy-telemetry">
                本次发送给 AI：{summary.telemetry.candidateCount} 个候选 / {summary.telemetry.evidenceMessageCount} 条证据消息
                {summary.telemetry.cacheHit ? ' · 已使用本地缓存，本次未重新发送' : ''}
              </div>
            )}

            <section className="section-heading">
              <div><span>今日价值筛选 · 优先级排序</span><h2>今日最重要</h2></div>
              <small>按今日价值、优先级与 D1 分数综合排序</small>
            </section>

            <section className="highlights">
              {summary.items.map((item, index) => (
                <div className="candidate-wrap" key={item.candidateId}>
                  <article>
                    <div className="rank">{String(index + 1).padStart(2, '0')}</div>
                    <div className="card-copy">
                      <div className="candidate-heading">
                        <h3>{item.title}</h3>
                        <div className="item-badges"><span>{item.category}</span><b>{importanceLabel(item.importanceLevel)}</b></div>
                      </div>
                      <p className="summary-copy">{item.summary}</p>
                      <div className="why"><strong>为什么值得关注</strong>{item.whyItMatters}</div>
                      <div className="reason-list">{item.reasonCodes.map((code) => <span key={code}>{reasonLabel(code)}</span>)}</div>
                      <div className="meta">
                        <span>{item.conversationCount} 个群</span>
                        <span>{item.messageCount} 条相关消息</span>
                        <span>最早 {formatTime(item.firstSeenAt)}</span>
                      </div>
                    </div>
                    <div className="candidate-actions">
                      <DailyFeedbackControls item={item} state={dailyFeedback[item.candidateId] ?? null} onSave={saveDailyItemFeedback} />
                      <button type="button" onClick={() => void toggleEvidence(item.candidateId)}>
                        {openCandidateId === item.candidateId ? '收起依据' : '查看依据'}
                      </button>
                    </div>
                  </article>
                  {openCandidateId === item.candidateId && <EvidencePanel evidence={evidence} />}
                </div>
              ))}
              {summary.items.length === 0 && <div className="empty-candidates">{summary.messageCount === 0 ? '当天没有聊天记录' : '当天没有值得关注的情报。'}</div>}
            </section>
            {summary.messageCount > 0 && <MissingImportantFeedback dateKey={summary.date} />}
          </>
        )}
        {page === 'radar' && !radar && !error && <div className="loading">正在计算过去 7 天历史基线……</div>}
        {page === 'radar' && radar && (
          <>
            {radar.dataQualityNotice && <div className="data-quality-notice">{radar.dataQualityNotice}</div>}
            <RadarPage radar={radar} openTopicId={openTopicId} evidence={topicEvidence} onToggleEvidence={toggleTopicEvidence} />
          </>
        )}
        {page === 'search' && (
          <SearchPage
            question={question}
            querying={querying}
            response={queryResponse}
            openMessageId={openMessageId}
            context={messageContext}
            onQuestionChange={setQuestion}
            onSubmit={submitQuestion}
            onToggleContext={toggleMessageContext}
          />
        )}
        {page === 'settings' && firstUse && (
          <SettingsPage status={firstUse} importing={importing} onImportFile={chooseFile} onConfigure={beginWechatImport} onCheck={refreshFirstUse} />
        )}
      </main>
    </div>
  )
}

function WelcomePage({ error, onDemo, onImport }: {
  error: string
  onDemo: () => Promise<void>
  onImport: () => Promise<void>
}): React.JSX.Element {
  return (
    <main className="welcome-page">
      <div className="welcome-mark">PR</div>
      <p className="welcome-name">PrivateRadar</p>
      <h1>把看不完的群聊，变成真正值得看的情报。</h1>
      <p className="welcome-copy">从重要消息、升温话题到历史聊天搜索，所有结果都能回到原始消息查看依据。</p>
      {error && <div className="error">{error}</div>}
      <div className="welcome-actions">
        <button type="button" className="welcome-choice primary" onClick={() => void onDemo()}><strong>体验 Demo</strong><span>无需微信，立即体验 PrivateRadar</span></button>
        <button type="button" className="welcome-choice" onClick={() => void onImport()}><strong>导入我的微信聊天</strong><span>开始使用自己的聊天记录</span></button>
      </div>
      <small className="welcome-privacy">聊天原文默认保存在你的电脑上。</small>
    </main>
  )
}

function WechatImportGuide({ status, onBack, onRefresh }: {
  status: FirstUseStatus
  onBack: () => void
  onRefresh: () => Promise<FirstUseStatus>
}): React.JSX.Element {
  const [opening, setOpening] = useState(false)
  const [checking, setChecking] = useState(false)
  const [openError, setOpenError] = useState('')
  const [setupNotice, setSetupNotice] = useState('')
  async function openConfiguration(): Promise<void> {
    setOpening(true)
    setOpenError('')
    try {
      const result = await window.privateRadar.openWorkBuddyConfig()
      setOpenError(result.openError ?? '')
      setSetupNotice(result.openError ? '' : result.trustReason === 'configuration_changed'
        ? 'PrivateRadar 的微信连接组件已升级，需要在 WorkBuddy 中重新确认一次信任。'
        : 'PrivateRadar 已加入 WorkBuddy。请在 WorkBuddy 的列表中找到 privateradar-workbuddy，并点击“信任”。')
    } catch (reason) {
      setSetupNotice('')
      setOpenError(reason instanceof Error ? reason.message : '无法准备连接组件')
    } finally {
      setOpening(false)
    }
  }
  async function checkConnection(): Promise<void> {
    setChecking(true)
    setOpenError('')
    setSetupNotice('正在检查…')
    try {
      const result = await onRefresh()
      setSetupNotice(result.workBuddyConnectionMessage)
    } catch (reason) {
      setSetupNotice('')
      setOpenError(reason instanceof Error ? reason.message : '无法检查 WorkBuddy 连接')
    } finally {
      setChecking(false)
    }
  }
  return (
    <main className="onboarding-page">
      <button className="text-back" type="button" onClick={onBack}>← 返回</button>
      <div className="onboarding-card">
        <span className="step-label">导入微信聊天</span>
        <h1>把聊天分享到 WorkBuddy</h1>
        <div className={status.workBuddyConnected ? 'connection-state connected' : 'connection-state'}>
          <strong>{status.workBuddyConnected ? '✓ 已连接' : '⚠ 尚未连接'}</strong>
          <span>{status.workBuddyConnected ? 'PrivateRadar 已准备好接收微信聊天。' : '还差一步即可使用微信导入。'}</span>
        </div>
        {!status.workBuddyConnected ? (
          <section className="setup-steps">
            <h2>配置 WorkBuddy</h2>
            {!status.workBuddyInstalled && <p className="setup-hint">尚未检测到 WorkBuddy。请先安装并打开 WorkBuddy，然后继续下面的步骤。</p>}
            {status.connectorRequiresRetrust && <p className="setup-hint">PrivateRadar 的微信连接组件已升级，需要在 WorkBuddy 中重新确认一次信任。</p>}
            <ol><li>点击“配置 WorkBuddy”，PrivateRadar 会自动完成注册。</li><li>回到 WorkBuddy 的列表，找到 <code>privateradar-workbuddy</code>。</li><li>点击“信任”，再回到 PrivateRadar 检查连接。</li></ol>
            <p className="setup-hint">WorkBuddy 会要求你确认一次 PrivateRadar 连接组件，这是正常的安全保护。</p>
            <div className="guide-actions"><button className="primary-action" type="button" onClick={() => void openConfiguration()} disabled={opening}>{opening ? '正在准备…' : '配置 WorkBuddy'}</button><button type="button" onClick={() => void checkConnection()} disabled={checking}>{checking ? '正在检查…' : '检查连接'}</button></div>
            {setupNotice && <div className="mode-notice">{setupNotice}</div>}
            {openError && <div className="error">配置未完成：{openError}</div>}
          </section>
        ) : (
          <section className="share-steps">
            <h2>在 Windows 微信中</h2>
            <div className="share-flow"><span>多选聊天记录</span><b>↓</b><span>转发 / 系统分享</span><b>↓</b><span>选择 WorkBuddy</span><b>↓</b><span>输入“将这份聊天记录导入 PrivateRadar”</span></div>
            <div className="mode-card recommended"><div><strong>快速导入</strong><b>推荐</b></div><p>只需要确认群名或会话名称。发送人和时间没有提供时可以直接跳过。</p></div>
            <details className="accuracy-options"><summary>提高分析精度</summary><p>可选补充大致日期和发送人标记。补充后，趋势分析和多人统计会更准确；这些字段都不是必须的。</p></details>
            <div className="waiting-import"><span />正在等待 WorkBuddy 完成导入……</div>
          </section>
        )}
        <section className="short-privacy"><p>PrivateRadar 默认将聊天数据保存在本机。</p><p>通过 WorkBuddy 分享的数据只用于你主动发起的导入。</p><p>PrivateRadar 不自动读取你的微信数据库。</p></section>
      </div>
    </main>
  )
}

function ImportCompletePage({ result, onRetry, onGo }: {
  result: LatestGuidedImport
  onRetry: () => Promise<void>
  onGo: (target: 'daily' | 'radar' | 'search') => void
}): React.JSX.Element {
  const failed = result.status === 'failed'
  return (
    <main className="onboarding-page complete-page">
      <div className={`onboarding-card completion-card ${failed ? 'failed' : ''}`}>
        <div className="completion-icon">{failed ? '!' : '✓'}</div>
        <span className="step-label">{failed ? '导入未完成' : result.status === 'partial' ? '部分消息已导入' : '导入成功'}</span>
        <h1>{failed ? '这次没有保存聊天消息' : `已保存 ${result.recognizedCount} 条聊天消息`}</h1>
        {!failed && <><div className="completeness-list"><StatusLine label="正文" value={result.contentStatus === 'complete' ? '完整' : '部分缺失'} ok={result.contentStatus === 'complete'} /><StatusLine label="群名" value={result.conversationStatus === 'confirmed' ? '已确认' : '未提供'} ok={result.conversationStatus === 'confirmed'} /><StatusLine label="发送人" value={result.senderStatus === 'confirmed' ? '已确认' : '未提供'} ok={result.senderStatus === 'confirmed'} /><StatusLine label="原始时间" value={result.timestampStatus === 'confirmed' ? '已确认' : result.timestampStatus === 'approximate' ? '仅有大致日期' : '未提供'} ok={result.timestampStatus === 'confirmed'} /></div><p className="capability-copy">{result.capabilityNotice}</p><details className="technical-details"><summary>查看详情</summary><div><span>新增 {result.importedCount}</span><span>重复 {result.duplicateCount}</span><span>更新 {result.updatedCount}</span><span>无效 {result.invalidCount}</span></div></details><div className="next-actions"><button type="button" onClick={() => onGo('daily')}>看看今天最重要的消息</button><button type="button" onClick={() => onGo('radar')}>看看什么正在变热</button><button type="button" onClick={() => onGo('search')}>搜索我的聊天</button></div></>}
        {failed && <button className="primary-action" type="button" onClick={() => void onRetry()}>重新尝试</button>}
      </div>
    </main>
  )
}

function StatusLine({ label, value, ok }: { label: string; value: string; ok: boolean }): React.JSX.Element {
  return <div><span>{label}</span><strong className={ok ? 'status-ok' : 'status-muted'}>{value}</strong></div>
}

const DAILY_NEGATIVE_REASONS = ['不重要', '普通闲聊', '和我无关', '重复信息', '判断错了', '其他']
const SEARCH_NEGATIVE_REASONS = ['没找到应该找到的内容', '找到了错误内容', '回答和证据不一致', '回答不完整', '其他']

function DailyFeedbackControls({ item, state, onSave }: {
  item: DailyBriefItem
  state: FeedbackState | null
  onSave: (item: DailyBriefItem, vote: 'USEFUL' | 'SHOULD_NOT_SHOW', reasonCode?: string | null, note?: string | null) => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const label = state?.vote === 'USEFUL' ? '已标记有用' : state?.vote === 'SHOULD_NOT_SHOW' ? '已标记不该出现' : ''
  async function save(vote: 'USEFUL' | 'SHOULD_NOT_SHOW', selectedReason?: string): Promise<void> {
    setSaving(true)
    try {
      await onSave(item, vote, selectedReason || null, note || null)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  return <div className="feedback-controls daily-feedback">
    <div className="feedback-actions">
      <button type="button" className={state?.vote === 'USEFUL' ? 'feedback-button selected' : 'feedback-button'} disabled={saving} onClick={() => void save('USEFUL')}>有用</button>
      <button type="button" className={state?.vote === 'SHOULD_NOT_SHOW' ? 'feedback-button selected negative' : 'feedback-button'} disabled={saving} onClick={() => setEditing((current) => !current)}>不该出现</button>
    </div>
    {label && !editing && <small className="feedback-status">{label}</small>}
    {editing && <div className="feedback-editor">
      <span>原因可选</span>
      <div className="feedback-reasons">{DAILY_NEGATIVE_REASONS.map((itemReason) => <button className={reason === itemReason ? 'selected' : ''} type="button" key={itemReason} onClick={() => setReason(itemReason)}>{itemReason}</button>)}</div>
      <input value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="补充说明（可选）" aria-label="不该出现的补充说明" />
      <div className="feedback-editor-actions"><button type="button" disabled={saving} onClick={() => void save('SHOULD_NOT_SHOW', reason)}>保存反馈</button><button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button></div>
    </div>}
  </div>
}

function MissingImportantFeedback({ dateKey }: { dateKey: string }): React.JSX.Element {
  const [showForm, setShowForm] = useState(false)
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  async function submit(): Promise<void> {
    setSaving(true)
    try {
      await window.privateRadar.saveMissingImportantFeedback({ dateKey, note: note || null })
      setSaved(true)
      setShowForm(false)
    } finally {
      setSaving(false)
    }
  }
  if (saved) return <section className="missing-feedback"><strong>感谢反馈</strong><span>已记录今天可能遗漏的重要内容。</span></section>
  return <section className="missing-feedback">
    <strong>今天有重要内容被漏掉了吗？</strong>
    <div className="feedback-actions"><button type="button" onClick={() => setShowForm(false)}>没有</button><button type="button" onClick={() => setShowForm(true)}>有</button></div>
    {showForm && <div className="feedback-editor"><p>可以简单描述一下（可选），之后我们会结合本地聊天记录人工分析。</p><input value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="例如：群里有人说某产品今天大更新了" aria-label="遗漏重要内容说明" /><div className="feedback-editor-actions"><button type="button" disabled={saving} onClick={() => void submit()}>记录反馈</button><button type="button" disabled={saving} onClick={() => setShowForm(false)}>取消</button></div></div>}
  </section>
}

function SettingsPage({ status, importing, onImportFile, onConfigure, onCheck }: {
  status: FirstUseStatus
  importing: boolean
  onImportFile: () => Promise<void>
  onConfigure: () => Promise<void>
  onCheck: () => Promise<FirstUseStatus>
}): React.JSX.Element {
  const [notice, setNotice] = useState('')
  const [checking, setChecking] = useState(false)
  async function openDirectory(kind: 'data' | 'log'): Promise<void> {
    const error = kind === 'data' ? await window.privateRadar.openDataDirectory() : await window.privateRadar.openLogDirectory()
    setNotice(error ? `无法打开目录：${error}` : '')
  }
  async function checkConnection(): Promise<void> {
    setChecking(true)
    setNotice('正在检查…')
    try {
      const result = await onCheck()
      setNotice(result.workBuddyConnectionMessage)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : '无法检查 WorkBuddy 连接')
    } finally {
      setChecking(false)
    }
  }
  async function exportFeedback(): Promise<void> {
    const result = await window.privateRadar.exportFeedback()
    if (result.cancelled) return
    setNotice(result.count === 0 ? '没有反馈记录，已导出空的反馈文件。' : `已导出 ${result.count} 条反馈记录。`)
  }
  return <section className="settings-page">
    <DataStatusCard status={status} />
    <div className="settings-grid"><div><span>PrivateRadar 版本</span><strong>{status.appVersion}</strong></div><div><span>本地数据库</span><strong>{status.databaseHealthy ? '正常' : '需要检查'}</strong></div></div>
    <div className="storage-card"><span>数据存储位置</span><code>{status.dataDirectory}</code><p>聊天原文默认保存在你的电脑上。安装升级和默认卸载不会删除这些数据。</p></div>
    <div className="settings-actions"><button className="primary-action" type="button" onClick={() => void checkConnection()} disabled={checking}>{checking ? '正在检查…' : '检查 WorkBuddy 连接'}</button><button type="button" onClick={() => void onConfigure()}>配置 WorkBuddy</button><button type="button" onClick={() => void openDirectory('data')}>打开数据目录</button><button type="button" onClick={() => void openDirectory('log')}>打开日志目录</button><button type="button" onClick={() => void onImportFile()} disabled={importing}>{importing ? '正在导入…' : '从文件导入'}</button><button type="button" onClick={() => void exportFeedback()}>导出测试反馈</button></div>
    {notice && <div className={status.workBuddyConnected ? 'mode-notice' : 'error'}>{notice}</div>}
  </section>
}

function DataStatusCard({ status }: { status: FirstUseStatus }): React.JSX.Element {
  const { latestAttempt, lastSuccessfulImport, latestMessageDate } = status.dataStatus
  if (!latestAttempt) return <section className="data-status-card data-status-empty">
    <div><span>数据状态</span><strong>尚未导入聊天数据</strong></div>
    <div className="data-status-summary"><span>累计</span><strong>{status.totalMessageCount.toLocaleString()} 条消息 · {status.importBatchCount.toLocaleString()} 个聊天批次</strong></div>
    <div className="data-status-summary"><span>WorkBuddy</span><strong>{status.workBuddyConnected ? '已连接' : '未连接'}</strong></div>
  </section>
  const successfulLatest = latestAttempt.status === 'success' || latestAttempt.status === 'partial'
  return <section className="data-status-card">
    <div className="data-status-heading"><span>数据状态</span><div className="data-status-recent"><strong>最近一次导入</strong><span>{latestAttempt.source} · {formatDateTime(latestAttempt.completedAt)}</span></div><b className={`import-status ${latestAttempt.status}`}>{importStatusLabel(latestAttempt.status)}</b></div>
    <div className="data-status-metrics"><span>新增 <strong>{latestAttempt.importedCount}</strong></span><span>重复 <strong>{latestAttempt.duplicateCount}</strong></span><span>更新 <strong>{latestAttempt.updatedCount}</strong></span><span>错误 <strong>{latestAttempt.errorCount}</strong></span></div>
    {!successfulLatest && lastSuccessfulImport && <div className="data-status-last-success"><span>最近成功导入</span><strong>{lastSuccessfulImport.source} · {formatDateTime(lastSuccessfulImport.completedAt)}</strong></div>}
    <div className="data-status-facts"><div className="data-status-summary"><span>数据最新至</span><strong>{latestMessageDate ?? '暂无消息'}</strong></div><div className="data-status-summary"><span>累计</span><strong>{status.totalMessageCount.toLocaleString()} 条消息 · {status.importBatchCount.toLocaleString()} 个聊天批次</strong></div><div className="data-status-summary"><span>WorkBuddy</span><strong>{status.workBuddyConnected ? '已连接' : '未连接'}</strong></div></div>
  </section>
}

function importStatusLabel(status: 'success' | 'partial' | 'failed'): string {
  return status === 'success' ? '成功' : status === 'partial' ? '部分完成' : '失败'
}

function RadarPage({
  radar,
  openTopicId,
  evidence,
  onToggleEvidence
}: {
  radar: TopicRadarSummary
  openTopicId: string
  evidence: TopicEvidence | null
  onToggleEvidence: (topicId: string, date: string) => Promise<void>
}): React.JSX.Element {
  return (
    <>
      <section className="radar-stats">
        <Stat label="历史基线" value={radar.historyDays} suffix="天" />
        <Stat label="正在升温" value={radar.topics.length} suffix="个" />
      </section>
      <section className="section-heading">
        <div><span>相对历史变化 · 本地规则</span><h2>正在升温</h2></div>
        <small>Signal Score 不等于绝对消息量</small>
      </section>
      <section className="topic-list">
        {radar.topics.map((topic, index) => (
          <div className="topic-wrap" key={topic.topicId}>
            <article className="topic-card">
              <div className="rank">{String(index + 1).padStart(2, '0')}</div>
              <div className="topic-copy">
                <div className="candidate-heading"><h3>{topic.canonicalName}</h3><b>{topic.signalScore.toFixed(2)} Signal</b></div>
                <div className="topic-metrics">
                  <span>今日消息<strong>{topic.messageCount}</strong></span>
                  <span>今日群数<strong>{topic.conversationCount}</strong></span>
                  <span>今日人数<strong>{senderCountLabel(topic.senderCount)}</strong></span>
                  <span>历史日均<strong>{topic.historicalAvgMessageCount.toFixed(1)}</strong></span>
                  <span>增长<strong>{growthLabel(topic.growthRate)}</strong></span>
                  <span>首次出现<strong>{formatDateTime(topic.firstSeenAt)}</strong></span>
                </div>
                <TopicTrend topic={topic} />
                <div className="reason-list">{topic.reasonCodes.map((code) => <span key={code}>{topicReasonLabel(code)}</span>)}</div>
              </div>
              <button type="button" onClick={() => void onToggleEvidence(topic.topicId, topic.date)}>
                {openTopicId === topic.topicId ? '收起依据' : '查看依据'}
              </button>
            </article>
            {openTopicId === topic.topicId && <TopicEvidencePanel evidence={evidence} />}
          </div>
        ))}
        {radar.topics.length === 0 && <div className="empty-candidates">今天没有达到升温阈值的话题。</div>}
      </section>
    </>
  )
}

function SearchPage({
  question,
  querying,
  response,
  openMessageId,
  context,
  onQuestionChange,
  onSubmit,
  onToggleContext
}: {
  question: string
  querying: boolean
  response: ChatQueryResponse | null
  openMessageId: string
  context: MessageContext | null
  onQuestionChange: (value: string) => void
  onSubmit: (value?: string) => Promise<void>
  onToggleContext: (messageId: string) => Promise<void>
}): React.JSX.Element {
  const examples = ['上个月谁推荐过 AI 工具？', '最近大家怎么评价 Claude Code？']
  return (
    <>
      <form className="chat-search" onSubmit={(event) => { event.preventDefault(); void onSubmit() }}>
        <div className="search-input-row">
          <input value={question} onChange={(event) => onQuestionChange(event.target.value)} placeholder="例如：之前谁分享过微信小程序 GitHub 项目？" aria-label="询问聊天记录" />
          <button type="submit" disabled={querying || !question.trim()}>{querying ? '正在检索…' : '检索聊天'}</button>
        </div>
        <div className="query-examples"><span>试试：</span>{examples.map((example) => <button type="button" key={example} onClick={() => void onSubmit(example)}>{example}</button>)}</div>
      </form>

      {response && (
        <section className="query-response">
          <div className="query-summary-bar">
            <span>时间范围<strong>{response.understanding.dateRange.label}</strong></span>
            <span>命中消息<strong>{response.hitMessageCount}</strong></span>
            <span>涉及群<strong>{response.conversationCount}</strong></span>
            <span>涉及人数<strong>{senderCountLabel(response.senderCount)}</strong></span>
            <span>检索模式<strong>{response.telemetry.retrievalMode}</strong></span>
          </div>

          {response.answer && (
            <div className={response.insufficientEvidence ? 'grounded-answer insufficient' : 'grounded-answer'}>
              <span>{response.queryType === 'summarize' ? '基于聊天记录的回答' : '回答'}</span>
              <h2>{response.answer}</h2>
              {!response.insufficientEvidence && response.queryType === 'summarize' && (
                <small>{response.telemetry.aiMode} · 分析 {response.sourceMessageIds.length} 条证据 · 最终来源由程序控制</small>
              )}
            </div>
          )}
          <SearchFeedbackControls question={question} response={response} />

          {!response.insufficientEvidence && (
            <>
              <section className="section-heading search-heading">
                <div><span>检索 → 证据 → 回答</span><h2>相关聊天证据</h2></div>
                <small>按混合相关性排序</small>
              </section>
              {response.results.length > 0 && <div className="search-results">
                {response.results.map((result) => (
                  <div className="search-result-wrap" key={result.messageId}>
                    <article className="search-result-card">
                      <div className="search-result-meta"><strong>{displayMetadata(result.senderName, '发送人未提供')}</strong><span>{displayMetadata(result.conversationName, '群名未提供')}</span><span>{formatDateTime(result.timestamp)}</span><b>{result.relevanceScore.toFixed(3)}</b></div>
                      <p>{result.content}</p>
                      {result.links.length > 0 && <div className="result-links">{result.links.map((link) => <span key={link}>{link}</span>)}</div>}
                      <div className="search-result-footer">
                        <div className="reason-list">{result.matchReasons.map((reason) => <span key={reason}>{reason}</span>)}</div>
                        <button type="button" onClick={() => void onToggleContext(result.messageId)}>{openMessageId === result.messageId ? '收起上下文' : '查看上下文'}</button>
                      </div>
                    </article>
                    {openMessageId === result.messageId && <MessageContextPanel context={context} />}
                  </div>
                ))}
              </div>}
              {response.unverifiedTimeResults.length > 0 && <section className="search-time-unverified">
                <p>以下相关聊天未提供原始时间，无法确认是否发生在{response.understanding.dateRange.label}。</p>
                <div className="search-results">
                  {response.unverifiedTimeResults.map((result) => (
                    <div className="search-result-wrap" key={result.messageId}>
                      <article className="search-result-card">
                        <div className="search-result-meta"><strong>{displayMetadata(result.senderName, '发送人未提供')}</strong><span>{displayMetadata(result.conversationName, '群名未提供')}</span><span>原始时间未提供</span><b>{result.relevanceScore.toFixed(3)}</b></div>
                        <p>{result.content}</p>
                        {result.links.length > 0 && <div className="result-links">{result.links.map((link) => <span key={link}>{link}</span>)}</div>}
                        <div className="search-result-footer">
                          <div className="reason-list">{result.matchReasons.map((reason) => <span key={reason}>{reason}</span>)}</div>
                          <button type="button" onClick={() => void onToggleContext(result.messageId)}>{openMessageId === result.messageId ? '收起上下文' : '查看上下文'}</button>
                        </div>
                      </article>
                      {openMessageId === result.messageId && <MessageContextPanel context={context} />}
                    </div>
                  ))}
                </div>
              </section>}
            </>
          )}
        </section>
      )}
    </>
  )
}

function SearchFeedbackControls({ question, response }: { question: string; response: ChatQueryResponse }): React.JSX.Element {
  const [state, setState] = useState<FeedbackState | null>(null)
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const sourceKey = response.sourceMessageIds.join('\u001f')
  useEffect(() => {
    if (!question.trim()) return
    void window.privateRadar.getSearchFeedbackState(question, response.sourceMessageIds)
      .then((next) => { setState(next); setReason(next?.reasonCode ?? ''); setNote(next?.note ?? '') })
      .catch(() => setState(null))
  }, [question, sourceKey])
  async function save(vote: 'CORRECT' | 'INCORRECT', selectedReason?: string): Promise<void> {
    setSaving(true)
    try {
      setState(await window.privateRadar.saveSearchFeedback({ question, response, vote, reasonCode: selectedReason || null, note: note || null }))
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  const label = state?.vote === 'CORRECT' ? '✓ 已标记找对了' : state?.vote === 'INCORRECT' ? '✓ 已标记没找对' : ''
  return <section className="search-feedback feedback-controls">
    <strong>这个结果找对了吗？</strong>
    <div className="feedback-actions"><button type="button" className={state?.vote === 'CORRECT' ? 'feedback-button selected' : 'feedback-button'} disabled={saving} onClick={() => void save('CORRECT')}>找对了</button><button type="button" className={state?.vote === 'INCORRECT' ? 'feedback-button secondary selected negative' : 'feedback-button secondary'} disabled={saving} onClick={() => setEditing((current) => !current)}>没找对</button></div>
    {label && !editing && <small className="feedback-status">{label}</small>}
    {editing && <div className="feedback-editor"><span>原因可选</span><div className="feedback-reasons">{SEARCH_NEGATIVE_REASONS.map((itemReason) => <button className={reason === itemReason ? 'selected' : ''} type="button" key={itemReason} onClick={() => setReason(itemReason)}>{itemReason}</button>)}</div><input value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="补充说明（可选）" aria-label="检索反馈补充说明" /><div className="feedback-editor-actions"><button type="button" disabled={saving} onClick={() => void save('INCORRECT', reason)}>保存反馈</button><button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button></div></div>}
  </section>
}

function MessageContextPanel({ context }: { context: MessageContext | null }): React.JSX.Element {
  if (!context) return <div className="evidence-panel">正在读取前后文……</div>
  return (
    <div className="evidence-panel">
      <div className="evidence-title">原始消息与前后文</div>
      {context.messages.map((message) => (
        <div className={message.isSource ? 'evidence-message source' : 'evidence-message'} key={message.messageId}>
          <div><strong>{displayMetadata(message.senderName, '发送人未提供')}</strong><span>{displayMetadata(message.conversationName, '群名未提供')} · {formatTime(message.timestamp)}</span></div>
          <p>{message.content}</p>
        </div>
      ))}
    </div>
  )
}

function TopicTrend({ topic }: { topic: TopicRadarItem }): React.JSX.Element {
  const max = Math.max(1, ...topic.trend.map((point) => point.messageCount))
  return (
    <div className="topic-trend" aria-label="最近七天趋势">
      {topic.trend.map((point) => (
        <div key={point.date} title={`${point.date}：${point.messageCount} 条`}>
          <span style={{ height: `${Math.max(3, point.messageCount / max * 34)}px` }} />
          <small>{point.date.slice(5)}</small><b>{point.messageCount}</b>
        </div>
      ))}
    </div>
  )
}

function TopicEvidencePanel({ evidence }: { evidence: TopicEvidence | null }): React.JSX.Element {
  if (!evidence) return <div className="evidence-panel">正在读取原始消息……</div>
  return (
    <div className="evidence-panel">
      <div className="evidence-title">今日话题原始依据</div>
      {evidence.messages.map((message) => (
        <div className="evidence-message source" key={message.messageId}>
          <div><strong>{displayMetadata(message.senderName, '发送人未提供')}</strong><span>{displayMetadata(message.conversationName, '群名未提供')} · {formatTime(message.timestamp)}</span></div>
          <p>{message.content}</p>
        </div>
      ))}
    </div>
  )
}

function EvidencePanel({ evidence }: { evidence: CandidateEvidence | null }): React.JSX.Element {
  if (!evidence) return <div className="evidence-panel">正在读取原始消息……</div>
  return (
    <div className="evidence-panel">
      <div className="evidence-title">判断说明与原始依据</div>
      <div className="evidence-judgment">
        <span>今日价值<strong>{dailyValueLabel(evidence.judgment.dailyValue)}</strong></span>
        <span>优先级<strong>{priorityShortLabel(evidence.judgment.dailyPriority)}</strong></span>
        <span>信息信号分<strong>{evidence.judgment.informationSignalScore.toFixed(2)}</strong></span>
        <p><strong>判断依据</strong>{evidence.judgment.valueReasonCodes.map(valueReasonLabel).join('、')}</p>
        <p><strong>命中的信息信号</strong>{evidence.judgment.informationSignals.map(reasonLabel).join('、')}</p>
      </div>
      {evidence.groups.map((group) => (
        <div className="evidence-group" key={group.sourceMessageId}>
          {group.messages.map((item) => (
            <div className={item.isSource ? 'evidence-message source' : 'evidence-message'} key={`${group.sourceMessageId}-${item.messageId}`}>
              <div><strong>{displayMetadata(item.senderName, '发送人未提供')}</strong><span>{displayMetadata(item.conversationName, '群名未提供')} · {formatTime(item.timestamp)}</span></div>
              <p>{item.content}</p>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const REASON_LABELS: Record<DailyReasonCode, string> = {
  MULTI_CONVERSATION: '多个群出现',
  MULTI_SENDER: '多人提到',
  HAS_LINK: '包含链接',
  TRUSTED_LINK: '常见可信域名',
  GITHUB_REFERENCE: 'GitHub 项目',
  HIGH_DISCUSSION: '讨论度较高',
  INFORMATION_DENSE: '信息较密集',
  PRODUCT_OR_VERSION: '产品或版本',
  SPECIFIC_NUMBER_OR_DATE: '含数字或日期',
  EVENT_OR_RELEASE: '明确事件或发布',
  FILE_OR_RESOURCE: '文件或资料',
  NEW_TOPIC: '近七天未出现'
}

const TOPIC_REASON_LABELS: Record<TopicReasonCode, string> = {
  RAPID_MESSAGE_GROWTH: '消息快速增长',
  RAPID_CONVERSATION_GROWTH: '群数快速增长',
  MULTI_CONVERSATION: '多个群出现',
  MULTI_SENDER: '多人参与',
  NEW_TOPIC: '新话题',
  CROSS_GROUP_SPREAD: '跨群传播',
  HIGH_D1_IMPORTANCE: 'D1 高重要性',
  SUSTAINED_GROWTH: '连续增长'
}

function reasonLabel(code: DailyReasonCode): string {
  return REASON_LABELS[code]
}

const DAILY_VALUE_LABELS: Record<DailyValue, string> = {
  must_show: '必须关注',
  may_show: '可酌情关注',
  drop: '不作为今日情报展示'
}

const DAILY_VALUE_REASON_LABELS: Record<DailyValueReasonCode, string> = {
  VERIFIABLE_UPDATE: '存在可验证的明确更新',
  TIMELY_MULTI_EVENT: '包含多个时效性事件',
  RISK_OR_LIMITATION: '涉及风险、故障或限制',
  ACTION_REQUIRED: '包含明确行动要求',
  BROAD_IMPACT: '影响范围较广',
  OPPORTUNITY_SIGNAL: '包含明确机会或需求线索',
  RELEVANT_RESOURCE: '资源用途与场景明确',
  UNVERIFIED_SINGLE_REPORT: '属于单人未经验证反馈',
  CONTEXTLESS: '缺少足够上下文',
  QUESTION_ONLY: '只有问题，没有明确事实',
  CHATTER: '属于普通交流',
  MEDIA_PLACEHOLDER: '仅为媒体占位内容',
  OPAQUE_TOKEN_ONLY: '仅含缺少语义的标记',
  BARE_LINK: '只有链接，未说明用途'
}

function dailyValueLabel(value: DailyValue): string {
  return DAILY_VALUE_LABELS[value]
}

function valueReasonLabel(code: DailyValueReasonCode): string {
  return DAILY_VALUE_REASON_LABELS[code]
}

function topicReasonLabel(code: TopicReasonCode): string {
  return TOPIC_REASON_LABELS[code]
}

function formatTime(value: string): string {
  if (!value) return '时间未提供'
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatDateTime(value: string): string {
  if (!value) return '时间未提供'
  const date = new Date(value)
  return `${date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

function displayMetadata(value: string, fallback: string): string {
  return value || fallback
}

function growthLabel(rate: number): string {
  if (rate >= 0) return `+${Math.round(rate * 100)}%`
  return `${Math.round(rate * 100)}%`
}

function modeLabel(summary: DashboardSummary): string {
  if (summary.mode === 'rule') return '规则模式'
  return summary.telemetry?.provider === 'mock' ? 'AI增强模式（模拟）' : 'AI增强模式'
}

function importanceLabel(value: 'high' | 'medium' | 'low'): string {
  return value === 'high' ? '高优先级' : value === 'medium' ? '中优先级' : '低优先级'
}

function priorityShortLabel(value: 'high' | 'medium' | 'low'): string {
  return value === 'high' ? '高' : value === 'medium' ? '中' : '低'
}

function ImportReport({ result }: { result: ImportResult }): React.JSX.Element {
  const state = result.status === 'success' ? '导入成功' : result.status === 'partial' ? '部分导入成功' : '导入失败'
  return (
    <section className={`import-report ${result.status}`}>
      <div className="import-title"><div><span>导入结果</span><h2>{result.fileName}</h2></div><b>{state}</b></div>
      <div className="import-grid">
        <div><span>文件类型</span><strong>{result.fileType}</strong></div>
        <div><span>识别消息</span><strong>{result.recognizedCount}</strong></div>
        <div><span>新增消息</span><strong>{result.importedCount}</strong></div>
        <div><span>更新消息</span><strong>{result.updatedCount}</strong></div>
        <div><span>重复消息</span><strong>{result.duplicateCount}</strong></div>
        <div><span>无效消息</span><strong>{result.invalidCount}</strong></div>
      </div>
      {result.errors.length > 0 && <details><summary>查看未导入原因</summary>{result.errors.map((item) => <p key={item}>{item}</p>)}</details>}
    </section>
  )
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix: string }): React.JSX.Element {
  return <div className="stat"><span>{label}</span><strong>{value.toLocaleString()}<small>{suffix}</small></strong></div>
}
