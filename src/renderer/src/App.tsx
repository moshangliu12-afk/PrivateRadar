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
import { EmptySignal, UiIcon } from './ui-components'
import type { UiIconName } from './ui-components'
import { CollectionPage } from './collection-page'
import { KeywordRadarPage } from './keyword-radar-page'
import { TodayKeywordInterestSection } from './today-keyword-interest-section'
import { CommitmentCandidatesPage } from './commitment-candidates-page'
import './commitment-candidates-page.css'
import { ConfirmedCommitmentsPage } from './confirmed-commitments-page'
import './confirmed-commitments-page.css'

const NAV_ITEMS = ['今日情报', '话题雷达', '问我的聊天', '设置', '批量收集', '关键词雷达'].concat('承诺候选').concat('承诺表达（已确认）')

export function App(): React.JSX.Element {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [latestDate, setLatestDate] = useState<string | null>(null)
  const [dailyLoading, setDailyLoading] = useState(false)
  const [keywordRefreshRevision, setKeywordRefreshRevision] = useState(0)
  const [page, setPage] = useState<'welcome' | 'import-guide' | 'import-complete' | 'daily' | 'radar' | 'search' | 'settings' | 'collections' | 'keywords' | 'commitments' | 'confirmed-commitments'>('daily')
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
          setKeywordRefreshRevision(value => value + 1)
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
    if (status.manualJsonOnly) { setPage('settings'); return }
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
        setKeywordRefreshRevision(value => value + 1)
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
    setKeywordRefreshRevision(value => value + 1)
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
    setKeywordRefreshRevision(value => value + 1)
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
    return <WelcomePage error={error} manualJsonOnly={firstUse?.manualJsonOnly} onDemo={activateDemo} onImport={beginWechatImport} onCollect={() => setPage('collections')} />
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
          <span className="brand-mark">PR<span className="brand-mark-dot" /></span>
          <div><strong>PrivateRadar</strong><small>个人情报系统</small></div>
        </div>
        <div className="side-label">工作空间</div>
        <nav aria-label="页面导航">
          {NAV_ITEMS.map((item, index) => (
            firstUse?.manualJsonOnly && index === 4 ? null :
            <button
              className={(page === 'daily' && index === 0) || (page === 'radar' && index === 1) || (page === 'search' && index === 2) || (page === 'settings' && index === 3) || (page === 'collections' && index === 4) || (page === 'keywords' && index === 5) || (page === 'commitments' && index === 6) || (page === 'confirmed-commitments' && index === 7) ? 'active' : ''}
              key={item}
              type="button"
              aria-current={(page === 'daily' && index === 0) || (page === 'radar' && index === 1) || (page === 'search' && index === 2) || (page === 'settings' && index === 3) || (page === 'collections' && index === 4) || (page === 'keywords' && index === 5) || (page === 'commitments' && index === 6) || (page === 'confirmed-commitments' && index === 7) ? 'page' : undefined}
              onClick={index === 0 ? () => void openDaily() : index === 1 ? () => void openRadar() : index === 2 ? () => setPage('search') : index === 4 ? () => { setError(''); setPage('collections') } : index === 5 ? () => { setError(''); setPage('keywords') } : index === 6 ? () => { setError(''); setPage('commitments') } : index === 7 ? () => { setError(''); setPage('confirmed-commitments') } : () => { setPage('settings'); void refreshFirstUse() }}
            >
              <UiIcon name={(['radar', 'topics', 'search', 'settings', 'folder', 'spark', 'check', 'chat'] as const)[index]} /><span>{item}</span><i className="nav-indicator" />
            </button>
          ))}
        </nav>
        <div className="privacy-note"><span className="local-icon"><UiIcon name="shield" /></span><div><strong>本地优先</strong><small>聊天原文仅保存在本机</small></div></div>
      </aside>

      <main className={`content-column page-${page}`}>
        <div className="app-toolbar">
          <div className="header-actions">
            {summary?.demoMode && <span className="demo-badge">当前为示例数据</span>}
            {page === 'daily' && summary?.date && summary.mode === 'ai' && <button className="regenerate-button" type="button" onClick={() => void regenerate()} disabled={regenerating || dailyLoading}>{regenerating ? '正在整理…' : '重新生成'}</button>}
            <button className="import-button" type="button" onClick={() => void beginWechatImport()}><UiIcon name="inbox" />开始导入我的聊天</button>
          </div>
        </div>
        <header className="page-heading">
          <div>
            {page === 'daily' && selectedDate && latestDate
              ? <div className="eyebrow"><span className="eyebrow-mark" />每日简报<span className="eyebrow-divider">/</span><div className="daily-date-navigation" aria-label="情报日期导航">
                  <button type="button" aria-label="上一天" onClick={() => void loadSelectedDate(shiftLocalDateKey(selectedDate, -1))} disabled={dailyLoading}>‹</button>
                  <strong title={formatLocalDateKey(selectedDate)}>{selectedDate.replaceAll('-', '.')}</strong>
                  <button type="button" aria-label="下一天" onClick={() => void loadSelectedDate(shiftLocalDateKey(selectedDate, 1))} disabled={dailyLoading || !canNavigateToNextDate(selectedDate, latestDate)}>›</button>
                  {shouldShowReturnToLatest(selectedDate, latestDate) && <button className="return-latest-button" type="button" onClick={() => void goToLatestDate()} disabled={dailyLoading}>回到最新</button>}
                </div></div>
              : <div className="eyebrow"><span className="eyebrow-mark" />{page === 'confirmed-commitments' ? <>原话回看<span className="eyebrow-divider">/</span>你的确认记录</> : page === 'commitments' ? <>原话审核<span className="eyebrow-divider">/</span>承诺候选</> : page === 'keywords' ? <>关键词检查<span className="eyebrow-divider">/</span>新导入的聊天</> : page === 'collections' ? <>批量收集<span className="eyebrow-divider">/</span>固定归集身份</> : page === 'settings' ? <>数据与隐私<span className="eyebrow-divider">/</span>系统状态</> : page === 'radar' ? <>话题脉冲<span className="eyebrow-divider">/</span>{radar ? radar.date?.replaceAll('-', '.') ?? '无可靠聊天日期' : '正在读取日期'}</> : page === 'search' ? <>私有检索<span className="eyebrow-divider">/</span>{firstUse ? `数据最新至 ${firstUse.dataStatus.latestMessageDate?.replaceAll('-', '.') ?? '时间未知'}` : '正在读取日期'}</> : '每日简报'}</div>}
            <h1>{page === 'confirmed-commitments' ? '承诺表达（已确认）' : page === 'commitments' ? '承诺候选' : page === 'keywords' ? '关键词雷达' : page === 'collections' ? '批量收集' : page === 'daily' ? '今日情报' : page === 'radar' ? '话题雷达' : page === 'search' ? '问我的聊天' : '设置'}</h1>
            <p>{page === 'confirmed-commitments' ? '仅表示你确认原话表达了承诺，不代表已完成或需要你执行。' : page === 'commitments' ? '查看原话、上下文和证据，确认或忽略已有候选。' : page === 'keywords' ? '设置你关心的词，之后新导入的聊天命中时会出现在这里。' : page === 'collections' ? '为多次聊天导入保留一个明确的收集记录。' : page === 'daily' ? '从噪音里，找到今天真正值得看的信息。' : page === 'radar' ? '识别相对过去七天正在突然升温的跨群话题。' : page === 'search' ? '先检索本地证据，再基于证据回答。' : '查看数据来源、存储状态与隐私说明。'}</p>
          </div>
        </header>

        {error && <div className="error">数据读取失败：{error}</div>}
        {!summary && !error && <div className="loading">正在读取本地消息……</div>}
        {page === 'daily' && summary && dailyLoading && <div className="loading">正在读取当日聊天……</div>}

        {importResult && <ImportReport result={importResult} />}

        {page === 'daily' && summary && !dailyLoading && (summary.date === null
          ? <EmptySignal kicker="日期信息待补充" title="无可靠聊天日期" description="时间未知的消息仍可通过搜索查找。" icon="chat" />
          : <>
            <section className="stats" aria-label="今日概览">
              <Stat label="当日分析群" value={summary.conversationCount} suffix="个" icon="topics" note="当日已分析的聊天群" />
              <Stat label="当日消息" value={summary.messageCount} suffix="条" icon="chat" note={`当日共 ${summary.messageCount.toLocaleString()} 条聊天消息`} />
              <Stat label="当日情报" value={summary.finalIntelligenceCount} suffix="条" icon="spark" note="经过今日价值筛选的结果" />
              <div className={`stat mode-stat ${summary.mode}`}><span>当前模式<i className="mode-dot" /></span><strong>{modeLabel(summary)}</strong><small className="metric-foot">{summary.mode === 'rule' ? '基于本地规则整理' : '基于证据进行 AI 整理'}</small></div>
            </section>

            {summary.modeNotice && <div className="mode-notice notice-strip" role="status"><span className="notice-icon">i</span>{summary.modeNotice}</div>}
            {summary.mode === 'ai' && summary.telemetry && (
              <div className="privacy-telemetry">
                本次发送给 AI：{summary.telemetry.candidateCount} 个候选 / {summary.telemetry.evidenceMessageCount} 条证据消息
                {summary.telemetry.cacheHit ? ' · 已使用本地缓存，本次未重新发送' : ''}
              </div>
            )}

            <section className={summary.items.length === 0 ? 'section-heading daily-important-empty-heading' : 'section-heading'}>
              <div><span>今日价值筛选 · 优先级排序</span><h2>今天最重要</h2></div>
              <small>按今日价值、优先级与 D1 分数综合排序</small>
            </section>

            <section className={summary.items.length === 0 ? 'highlights highlights-empty' : 'highlights'}>
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
              {summary.items.length === 0 && <EmptySignal title={summary.messageCount === 0 ? '当天没有聊天记录' : '今天没有值得关注的情报'} description={summary.messageCount === 0 ? '可以切换日期，查看已有聊天记录中的情报。' : '当日聊天已完成筛选，目前没有需要优先关注的信号。'} />}
            </section>
          </>)}
        {page === 'daily' && <TodayKeywordInterestSection refreshRevision={keywordRefreshRevision}
          onViewAll={() => { setError(''); setPage('keywords') }} />}
        {page === 'daily' && summary && !dailyLoading && summary.date !== null && summary.messageCount > 0 &&
          <MissingImportantFeedback dateKey={summary.date} />}
        {page === 'radar' && !radar && !error && <div className="loading">正在计算过去 7 天历史基线……</div>}
        {page === 'radar' && radar && (
          <>
            {radar.dataQualityNotice && <div className="data-quality-notice notice-strip" role="status"><span className="notice-icon">i</span>{radar.dataQualityNotice}</div>}
            {radar.date === null
              ? <div className="empty-candidates">无可靠聊天日期，暂无法按日期分析话题。时间未知的消息仍可通过搜索查找。</div>
              : <RadarPage radar={radar} openTopicId={openTopicId} evidence={topicEvidence} onToggleEvidence={toggleTopicEvidence} />}
          </>
        )}
        {page === 'search' && (
          <SearchPage
            status={firstUse}
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
        {page === 'collections' && <CollectionPage />}
        {page === 'keywords' && <KeywordRadarPage />}
        {page === 'commitments' && <CommitmentCandidatesPage />}
        {page === 'confirmed-commitments' && <ConfirmedCommitmentsPage />}
      </main>
    </div>
  )
}

export function WelcomePage({ error, manualJsonOnly, onDemo, onImport, onCollect }: {
  error: string
  manualJsonOnly?: boolean
  onDemo: () => Promise<void>
  onImport: () => Promise<void>
  onCollect: () => void
}): React.JSX.Element {
  return (
    <main className="welcome-page">
      <div className="welcome-mark">PR</div>
      <p className="welcome-name">PrivateRadar</p>
      <h1>把看不完的群聊，变成真正值得看的情报。</h1>
      <p className="welcome-copy">从重要消息、升温话题到历史聊天搜索，所有结果都能回到原始消息查看依据。</p>
      {error && <div className="error">{error}</div>}
      <div className="welcome-actions">
        <button type="button" className="welcome-choice primary" onClick={() => void onDemo()}><strong>体验示例聊天</strong><span>无需微信，立即体验 PrivateRadar</span></button>
        <button type="button" className="welcome-choice" onClick={() => void onImport()}><strong>{manualJsonOnly ? 'JSON 原始证据导入' : '导入我的微信聊天'}</strong><span>{manualJsonOnly ? '当前 macOS 内部版本支持 JSON 文件' : '开始使用自己的聊天记录'}</span></button>
      </div>
      {!manualJsonOnly && <button type="button" className="regenerate-button" onClick={onCollect}>开始批量收集</button>}
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

export function MissingImportantFeedback({ dateKey }: { dateKey: string }): React.JSX.Element {
  const [showForm, setShowForm] = useState(false)
  const [selection, setSelection] = useState<{ dateKey: string; choice: 'no' | 'yes' } | null>(null)
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const selectedChoice = selection?.dateKey === dateKey ? selection.choice : null
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
  if (saved) return <section className="missing-feedback feedback-card" role="status"><span className="feedback-mark"><UiIcon name="check" /></span><div className="feedback-copy"><strong>感谢反馈</strong><span>已记录今天可能遗漏的重要内容。</span></div></section>
  return <section className="missing-feedback feedback-card" aria-label="情报反馈">
    <span className="feedback-mark"><UiIcon name="chat" /></span>
    <div className="feedback-copy"><strong>今天有重要内容被漏掉了吗？</strong><span>反馈会保存在本机，供后续人工审计。</span></div>
    <div className="feedback-actions">
      <button type="button" aria-pressed={selectedChoice === 'no'} onClick={() => { setSelection({ dateKey, choice: 'no' }); setShowForm(false) }}>没有</button>
      <button type="button" aria-pressed={selectedChoice === 'yes'} onClick={() => { setSelection({ dateKey, choice: 'yes' }); setShowForm(true) }}>有</button>
    </div>
    {showForm && <div className="feedback-editor"><p>可以简单描述一下（可选），之后我们会结合本地聊天记录人工分析。</p><input value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="例如：群里有人说某产品今天大更新了" aria-label="遗漏重要内容说明" /><div className="feedback-editor-actions"><button type="button" disabled={saving} onClick={() => void submit()}>记录反馈</button><button type="button" disabled={saving} onClick={() => { setSelection(null); setShowForm(false) }}>取消</button></div></div>}
  </section>
}

export function SettingsPage({ status, importing, onImportFile, onConfigure, onCheck }: {
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
    <div className="settings-columns">
      <section className="settings-section" aria-labelledby="settings-health-title">
        <div className="settings-section-heading"><div><span className="settings-kicker">本机环境</span><h2 id="settings-health-title">运行状态</h2></div><span className="settings-section-index">02</span></div>
        <div className="settings-health-grid">
          <article className="settings-health-card"><span className="settings-card-icon"><UiIcon name="radar" /></span><div><span>PrivateRadar 版本</span><strong>{status.appVersion}</strong></div></article>
          <article className={`settings-health-card ${status.databaseHealthy ? 'healthy' : 'needs-attention'}`}><span className="settings-card-icon"><UiIcon name="database" /></span><div><span>本地数据库</span><strong>{status.databaseHealthy ? '正常' : '需要检查'}</strong></div><span className="settings-health-dot" aria-hidden="true" /></article>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="settings-storage-title">
        <div className="settings-section-heading"><div><span className="settings-kicker">隐私与存储</span><h2 id="settings-storage-title">本地数据</h2></div><span className="settings-section-index">03</span></div>
        <article className="settings-storage-card">
          <div className="settings-storage-top"><span className="settings-card-icon"><UiIcon name="shield" /></span><span className="settings-local-label">本地优先</span></div>
          <h3>你的聊天数据，保存在本机</h3>
          <p>聊天原文默认保存在你的电脑上。安装升级和默认卸载不会删除这些数据。</p>
          <div className="settings-storage-location"><UiIcon name="folder" /><div><span>PrivateRadar 数据存储路径</span><code>{status.dataDirectory}</code></div></div>
        </article>
      </section>
    </div>
    <section className="settings-section" aria-labelledby="settings-actions-title">
      <div className="settings-section-heading"><div><span className="settings-kicker">应用工具</span><h2 id="settings-actions-title">管理与诊断</h2></div><span className="settings-section-index">04</span></div>
      <div className="settings-action-grid">
        {!status.manualJsonOnly && <>
        <button className="settings-action-card primary-action" type="button" onClick={() => void checkConnection()} disabled={checking}><span className="settings-action-icon"><UiIcon name="link" /></span><span>{checking ? '正在检查…' : '检查 WorkBuddy 连接'}</span><UiIcon name="arrow" className="settings-action-arrow" /></button>
        <button className="settings-action-card" type="button" onClick={() => void onConfigure()}><span className="settings-action-icon"><UiIcon name="settings" /></span><span>配置 WorkBuddy</span><UiIcon name="arrow" className="settings-action-arrow" /></button>
        </>}
        <button className="settings-action-card" type="button" onClick={() => void openDirectory('data')}><span className="settings-action-icon"><UiIcon name="folder" /></span><span>打开数据目录</span><UiIcon name="arrow" className="settings-action-arrow" /></button>
        <button className="settings-action-card" type="button" onClick={() => void openDirectory('log')}><span className="settings-action-icon"><UiIcon name="inbox" /></span><span>打开日志目录</span><UiIcon name="arrow" className="settings-action-arrow" /></button>
        <button className="settings-action-card" type="button" onClick={() => void onImportFile()} disabled={importing}><span className="settings-action-icon"><UiIcon name="inbox" /></span><span>{importing ? '正在导入…' : status.manualJsonOnly ? 'JSON 原始证据导入' : '从文件导入'}</span><UiIcon name="arrow" className="settings-action-arrow" /></button>
        <button className="settings-action-card" type="button" onClick={() => void exportFeedback()}><span className="settings-action-icon"><UiIcon name="chat" /></span><span>导出测试反馈</span><UiIcon name="arrow" className="settings-action-arrow" /></button>
      </div>
      {notice && <div role="status" className={`settings-operation-notice ${status.workBuddyConnected ? 'mode-notice' : 'error'}`}>{notice}</div>}
    </section>
    <footer className="settings-footer"><span className="settings-footer-mark" aria-hidden="true"><UiIcon name="shield" /></span><span>本地数据 · 由你掌握</span></footer>
  </section>
}

function DataStatusCard({ status }: { status: FirstUseStatus }): React.JSX.Element {
  const { latestAttempt, lastSuccessfulImport, latestMessageDate } = status.dataStatus
  if (!latestAttempt) return <section className="settings-section" aria-labelledby="settings-source-title">
    <div className="settings-section-heading"><div><span className="settings-kicker">连接与导入</span><h2 id="settings-source-title">数据来源</h2></div><span className="settings-section-index">01</span></div>
    <article className="data-status-card data-status-empty">
      <div className="data-status-heading"><span className="settings-source-icon"><UiIcon name="inbox" /></span><div className="data-status-recent"><span>最近一次导入</span><strong>尚未导入聊天数据</strong></div></div>
      <div className="data-status-facts">
        <div className="data-status-summary"><span>数据最新至</span><strong>{latestMessageDate ?? '时间未知'}</strong></div>
        <div className="data-status-summary"><span>累计</span><strong>{status.totalMessageCount.toLocaleString()} 条消息 · {status.importBatchCount.toLocaleString()} 个聊天批次</strong></div>
        <div className="data-status-summary"><span>数据源状态</span><strong className={`settings-source-state ${status.workBuddyConnected ? 'connected' : 'disconnected'}`}><span aria-hidden="true" />{status.manualJsonOnly ? 'JSON 原始证据导入 · WorkBuddy 尚未支持' : <>WorkBuddy {status.workBuddyConnected ? '已连接' : '未连接'}</>}</strong></div>
      </div>
    </article>
  </section>
  const successfulLatest = latestAttempt.status === 'success' || latestAttempt.status === 'partial'
  return <section className="settings-section" aria-labelledby="settings-source-title">
    <div className="settings-section-heading"><div><span className="settings-kicker">连接与导入</span><h2 id="settings-source-title">数据来源</h2></div><span className="settings-section-index">01</span></div>
    <article className="data-status-card">
      <div className="data-status-heading"><span className="settings-source-icon"><UiIcon name="inbox" /></span><div className="data-status-recent"><span>最近一次导入</span><strong>{latestAttempt.source}<span className="settings-import-date"> · {formatDateTime(latestAttempt.completedAt)}</span></strong></div><b className={`import-status ${latestAttempt.status}`}>{importStatusLabel(latestAttempt.status)}</b></div>
      <div className="data-status-metrics"><small>导入结果</small><span>新增 <strong>{latestAttempt.importedCount}</strong></span><span>重复 <strong>{latestAttempt.duplicateCount}</strong></span><span>更新 <strong>{latestAttempt.updatedCount}</strong></span><span>错误 <strong>{latestAttempt.errorCount}</strong></span></div>
      {!successfulLatest && lastSuccessfulImport && <div className="data-status-last-success"><span>最近成功导入</span><strong>{lastSuccessfulImport.source} · {formatDateTime(lastSuccessfulImport.completedAt)}</strong></div>}
      <div className="data-status-facts">
        <div className="data-status-summary"><span>数据最新至</span><strong>{latestMessageDate ?? '时间未知'}</strong></div>
        <div className="data-status-summary"><span>累计</span><strong>{status.totalMessageCount.toLocaleString()} 条消息 · {status.importBatchCount.toLocaleString()} 个聊天批次</strong></div>
        <div className="data-status-summary"><span>数据源状态</span><strong className={`settings-source-state ${status.workBuddyConnected ? 'connected' : 'disconnected'}`}><span aria-hidden="true" />{status.manualJsonOnly ? 'JSON 原始证据导入 · WorkBuddy 尚未支持' : <>WorkBuddy {status.workBuddyConnected ? '已连接' : '未连接'}</>}</strong></div>
      </div>
    </article>
  </section>
}

function importStatusLabel(status: 'success' | 'partial' | 'failed'): string {
  return status === 'success' ? '成功' : status === 'partial' ? '部分完成' : '失败'
}

export function RadarPage({
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
    <div className="topics-page">
      <section className="radar-stats topic-stats" aria-label="话题趋势概览">
        <article className="topic-stat topic-stat-baseline">
          <div className="topic-stat-heading"><span>历史基线</span><UiIcon name="database" /></div>
          <div className="topic-stat-value">{radar.historyDays.toLocaleString()}<small>天</small></div>
          <p>趋势比较窗口</p>
        </article>
        <article className="topic-stat">
          <div className="topic-stat-heading"><span>新出现</span><UiIcon name="spark" /></div>
          <div className="topic-stat-value">{radar.newTopics.length.toLocaleString()}<small>个</small></div>
          <p>{radar.newTopics.length > 0 ? '今天首次进入视野的话题' : '今天没有新话题'}</p>
        </article>
        <article className="topic-stat">
          <div className="topic-stat-heading"><span>正在升温</span><UiIcon name="radar" /></div>
          <div className="topic-stat-value">{radar.warmingTopics.length.toLocaleString()}<small>个</small></div>
          <p>{radar.warmingTopics.length > 0 ? '相较历史基线关注度上升' : '没有明显升温信号'}</p>
        </article>
      </section>
      <TopicSection
        kind="new"
        title="新出现"
        description="今天首次出现的话题"
        topics={radar.newTopics}
        emptyText="今天没有新出现的话题"
        historyDays={radar.historyDays}
        openTopicId={openTopicId}
        evidence={evidence}
        onToggleEvidence={onToggleEvidence}
      />
      <TopicSection
        kind="warming"
        title="正在升温"
        description="相比近期历史明显增加的话题"
        topics={radar.warmingTopics}
        emptyText="暂未发现明显升温的话题"
        historyDays={radar.historyDays}
        notice={radar.historySufficient ? null : '历史数据不足，趋势仅供参考'}
        openTopicId={openTopicId}
        evidence={evidence}
        onToggleEvidence={onToggleEvidence}
      />
    </div>
  )
}

function TopicSection({
  kind,
  title,
  description,
  topics,
  emptyText,
  historyDays,
  notice,
  openTopicId,
  evidence,
  onToggleEvidence
}: {
  kind: 'new' | 'warming'
  title: string
  description: string
  topics: TopicRadarSummary['topics']
  emptyText: string
  historyDays: number
  notice?: string | null
  openTopicId: string
  evidence: TopicEvidence | null
  onToggleEvidence: (topicId: string, date: string) => Promise<void>
}): React.JSX.Element {
  return (
    <section className={`radar-section topic-section topic-section-${kind}`}>
      <div className="section-heading">
        <div><span>{description}</span><h2>{title}</h2></div>
        <small className="topic-score-key"><i aria-hidden="true" />Signal Score <span>表示值得注意程度</span></small>
      </div>
      {notice && <div className="trend-history-notice">{notice}</div>}
      <div className="topic-list">
        {topics.map((topic, index) => (
          <div className="topic-wrap" key={topic.topicId}>
            <article className="topic-card">
              <div className="rank">{String(index + 1).padStart(2, '0')}</div>
              <div className="topic-copy">
                <div className="candidate-heading"><h3>{topic.canonicalName}</h3><b className="topic-score">{topic.signalScore.toFixed(2)} Signal</b></div>
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
              <button type="button" aria-expanded={openTopicId === topic.topicId} onClick={() => void onToggleEvidence(topic.topicId, topic.date)}>
                {openTopicId === topic.topicId ? '收起依据' : '查看依据'}
              </button>
            </article>
            {openTopicId === topic.topicId && <TopicEvidencePanel evidence={evidence} />}
          </div>
        ))}
        {topics.length === 0 && (
          <article className="topic-empty">
            <div className="topic-empty-icon" aria-hidden="true">
              <UiIcon name={kind === 'new' ? 'spark' : 'radar'} />
            </div>
            <div className="topic-empty-copy">
              <h3>{emptyText}</h3>
              <p>{historyDays > 0 ? `趋势基线来自最近 ${historyDays} 天的数据。` : '尚无可用于趋势比较的历史数据。'}</p>
            </div>
            <span className="topic-empty-status">{kind === 'new' ? '暂无信号' : notice ? '基线积累中' : '趋势平稳'}</span>
          </article>
        )}
      </div>
    </section>
  )
}

export function SearchPage({
  status,
  question,
  querying,
  response,
  openMessageId,
  context,
  onQuestionChange,
  onSubmit,
  onToggleContext
}: {
  status: FirstUseStatus | null
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
    <div className="search-page">
      <div className="search-layout">
        <form className="chat-search" onSubmit={(event) => { event.preventDefault(); void onSubmit() }}>
          <div className="search-card-head">
            <span className="search-card-icon"><UiIcon name="search" /></span>
            <div><h2>从聊天记录中找答案</h2><p>输入问题，查找与你有关的本地聊天证据。</p></div>
            <span className="search-local-chip"><span />本机优先</span>
          </div>
          <div className="search-input-row">
            <label className="search-input-wrap">
              <UiIcon name="search" />
              <input value={question} onChange={(event) => onQuestionChange(event.target.value)} placeholder="例如：之前谁分享过微信小程序 GitHub 项目？" aria-label="询问聊天记录" />
              <span className="search-enter-hint" aria-hidden="true">↵</span>
            </label>
            <button type="submit" disabled={querying || !question.trim()}><span>{querying ? '正在检索…' : '检索聊天'}</span><UiIcon name="arrow" /></button>
          </div>
          <div className="query-examples"><span>试试：</span>{examples.map((example) => <button type="button" key={example} onClick={() => void onSubmit(example)}>{example}</button>)}</div>
        </form>

        <aside className="search-aside" aria-label="检索原则与本地索引">
          <section className="search-evidence-card">
            <div className="search-evidence-head"><span className="search-evidence-icon"><UiIcon name="shield" /></span><span>证据优先</span><span className="search-evidence-local">本地记录</span></div>
            <h2>答案要有来处</h2>
            <p>先定位相关聊天证据，再基于证据组织回答。回答与原始记录一起呈现，方便核对。</p>
            <div className="search-evidence-steps"><span><b>01</b>搜索本地记录</span><UiIcon name="arrow" /><span><b>02</b>基于证据作答</span></div>
          </section>
          <section className="search-index-card" aria-label="本地索引概况">
            <div className="search-index-head"><span>索引概况</span><UiIcon name="database" /></div>
            <div className="search-index-stats"><div><strong>{status ? status.totalMessageCount.toLocaleString() : '—'}</strong><span>条消息</span></div><div><strong>{status ? status.importBatchCount.toLocaleString() : '—'}</strong><span>个聊天批次</span></div></div>
            <p className={status?.databaseHealthy ? 'search-index-state healthy' : 'search-index-state'}><span />{status ? (status.databaseHealthy ? '本地数据库正常' : '本地数据库需要检查') : '正在读取本地索引状态…'}</p>
          </section>
        </aside>
      </div>

      {!response && <section className="search-answer-state" aria-live="polite">
        <span className="search-answer-icon"><UiIcon name="search" /></span>
        <div><span className="search-answer-kicker">{querying ? '正在查找本地证据' : '随时开始检索'}</span><h2>{querying ? '正在检索聊天记录' : '等待你的问题'}</h2><p>{querying ? '请稍候，正在定位与你的问题有关的聊天记录。' : '输入一个问题，PrivateRadar 会先查找本地聊天证据，再基于证据回答。'}</p></div>
        <span className="search-answer-local"><UiIcon name="shield" />本地聊天证据优先</span>
      </section>}

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
    </div>
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

export function ImportReport({ result }: { result: ImportResult }): React.JSX.Element {
  const state = result.status === 'success' ? '导入成功' : result.status === 'partial' ? '部分导入成功' : '导入失败'
  const sourceFailure = result.fileType === 'JSON' && result.status === 'failed' &&
    ['SOURCE_CONTENT_CONFLICT:', 'MANUAL_JSON_', 'NO_VALID_MESSAGES:'].some(prefix => result.errors[0]?.startsWith(prefix))
  return (
    <section className={`import-report ${result.status}`}>
      <div className="import-title"><div><span>导入结果</span><h2>{result.fileName}</h2></div><b>{state}</b></div>
      {sourceFailure && <p role="alert">{result.errors[0]}</p>}
      {result.errors.some(error => error.startsWith('POST_COMMIT_')) && <p role="status">{result.errors.find(error => error.startsWith('POST_COMMIT_'))}</p>}
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

export function Stat({ label, value, suffix, icon = 'radar', note }: { label: string; value: number; suffix: string; icon?: UiIconName; note?: string }): React.JSX.Element {
  return <div className="stat"><span>{label}<UiIcon name={icon} /></span><strong>{value.toLocaleString()}<small>{suffix}</small></strong>{note && <small className="metric-foot">{note}</small>}</div>
}
