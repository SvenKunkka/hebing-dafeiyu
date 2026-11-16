import * as React from 'react';

export type Call = (method: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
type Bot = { slug: string; displayName?: string; name?: string; description?: string; roles?: string[]; avatar?: string; avatarDataUrl?: string; protected?: boolean; [key: string]: any };
type Conflict = { id: string; title?: string; path?: string; description?: string; options?: Array<{ id: string; label?: string; body?: string; value?: string }>; [key: string]: any };
type Job = { id: string; status?: string; name?: string; sources?: any[]; conflicts?: Conflict[]; [key: string]: any };
type AnalysisEdits = { persona: string; memory: string; notes: string[]; conflicts: string[] };

const names: Record<string, string> = {
  draft: '待确认', preview: '待确认', previewed: '待确认', ready: '可合成', prepared: '可合成',
  committing: '合成中', creating: '合成中', committed: '已创建', created: '已创建', verified: '已验证',
  cleaning: '清理中', cleaned: '已完成', complete: '已完成', completed: '已完成', failed: '待处理', partial: '部分完成',
  cleanup_partial: '清理未完成', cleanup_failed: '清理未完成',
};
const ACTIVE_STATUSES = new Set(['created', 'committed', 'verified', 'cleaning', 'cleaned', 'complete', 'completed', 'cleanup_partial', 'cleanup_failed']);
function label(bot: any) { return bot?.displayName ?? bot?.name ?? bot?.slug ?? '未命名机器人'; }
function list(value: any, key: string): any[] { return Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : []; }
function jobOf(value: any): Job { return value?.job ?? value; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function safeAvatar(value: unknown) { return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value) ? value : undefined; }
function avatarOf(value: any) { return safeAvatar(value?.avatarDataUrl ?? value?.avatar?.dataUrl ?? value?.avatar); }
function analysisDraft(value: any): AnalysisEdits {
  return { persona: typeof value?.persona === 'string' ? value.persona : '', memory: typeof value?.memory === 'string' ? value.memory : '', notes: Array.isArray(value?.notes) ? value.notes : [], conflicts: Array.isArray(value?.conflicts) ? value.conflicts : [] };
}
function significantLines(value: string[]) { return value.filter((line) => line.trim()); }
function dateLabel(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function FusionPage({ call }: { call: Call }) {
  const [bots, setBots] = React.useState<Bot[]>([]);
  const [sources, setSources] = React.useState<Bot[]>([]);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [status, setStatus] = React.useState<any>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [name, setName] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [job, setJob] = React.useState<Job | null>(null);
  const [decisions, setDecisions] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState<string | null>('load');
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [dropActive, setDropActive] = React.useState(false);
  const [draggedCard, setDraggedCard] = React.useState<{ slug: string; x: number; y: number } | null>(null);
  const dropZoneRef = React.useRef<HTMLDivElement>(null);
  const pointerDrag = React.useRef<{ slug: string; x: number; y: number; moved: boolean } | null>(null);
  const suppressCardClick = React.useRef(false);
  const addFromPointer = React.useRef<(slug: string) => void>(() => {});
  const [cleanup, setCleanup] = React.useState<any>(null);
  const [schedulePreview, setSchedulePreview] = React.useState<any>(null);
  const [selectedSchedules, setSelectedSchedules] = React.useState<string[]>([]);
  const [scheduleAcknowledgement, setScheduleAcknowledgement] = React.useState('');
  const [acknowledgement, setAcknowledgement] = React.useState('');
  const [eraseMemory, setEraseMemory] = React.useState(false);
  const [acknowledgeUnmigrated, setAcknowledgeUnmigrated] = React.useState(false);
  const [analysisConsent, setAnalysisConsent] = React.useState(false);
  const [useAnalysis, setUseAnalysis] = React.useState(false);
  const [behaviorConfirmed, setBehaviorConfirmed] = React.useState(false);
  const [analysisEdits, setAnalysisEdits] = React.useState<AnalysisEdits | null>(null);
  const [conflictsReviewed, setConflictsReviewed] = React.useState(false);
  const mounted = React.useRef(true);
  const pendingRef = React.useRef(false);
  const activeJobId = React.useRef<string | undefined>();
  activeJobId.current = job?.id;
  const busy = pending !== null;

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    const responses = await Promise.allSettled([
      call('status', {}, signal), call('listBots', {}, signal),
      call('listJobs', {}, signal), call('listSources', {}, signal),
    ]);
    if (!mounted.current || signal?.aborted) return;
    const [state, botData, jobData, sourceData] = responses;
    if (state.status === 'fulfilled') setStatus(state.value);
    if (botData.status === 'fulfilled') setBots(list(botData.value, 'bots'));
    if (jobData.status === 'fulfilled') setJobs(list(jobData.value, 'jobs'));
    if (sourceData.status === 'fulfilled') setSources(list(sourceData.value, 'sources'));
    const failure = responses.find((item) => item.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }, [call]);

  React.useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    refresh(controller.signal).catch((reason) => {
      if (mounted.current && !controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (mounted.current && !controller.signal.aborted) setPending(null);
    });
    return () => { mounted.current = false; controller.abort(); };
  }, [refresh]);

  async function run(action: string, operation: () => Promise<void>) {
    if (busy || pendingRef.current) return;
    pendingRef.current = true;
    setPending(action); setError(null); setNotice(null);
    try { await operation(); }
    catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { pendingRef.current = false; if (mounted.current) setPending(null); }
  }

  function acceptJob(value: any) {
    const next = jobOf(value);
    if (!next || typeof next.id !== 'string') throw new Error('服务返回的融合任务缺少标识，请刷新任务历史后重试。');
    setJob(next);
    setName(next.name ?? '');
    setDecisions(next.decisions ?? {});
    setUseAnalysis(next.useAnalysis === true);
    setBehaviorConfirmed(next.verification?.behaviorConfirmed === true);
    setSelected((next.sources ?? []).map((source: any) => typeof source === 'string' ? source : source.slug).filter(Boolean));
    setJobs((existing) => [next, ...existing.filter((item) => item.id !== next.id)]);
  }

  function add(slug: string) {
    if (busy || !bots.some((bot) => bot.slug === slug && !bot.protected && bot.slug.toLowerCase() !== 'tob')) return;
    if (selected.length >= 12 && !selected.includes(slug)) { setError('每次最多融合 12 个机器人，请先移除一个再加入。'); return; }
    setSelected((current) => current.includes(slug) ? current : [...current, slug]);
    if (job) { setJob(null); setDecisions({}); }
    setNotice(null);
  }

  function remove(slug: string) {
    if (busy) return;
    setSelected((current) => current.filter((value) => value !== slug));
    if (job) { setJob(null); setDecisions({}); }
  }

  addFromPointer.current = add;
  React.useEffect(() => {
    function insideDropZone(x: number, y: number) {
      const rect = dropZoneRef.current?.getBoundingClientRect();
      return Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    }
    function move(event: PointerEvent) {
      const drag = pointerDrag.current;
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
      drag.moved = true;
      event.preventDefault();
      setDraggedCard({ slug: drag.slug, x: event.clientX, y: event.clientY });
      setDropActive(insideDropZone(event.clientX, event.clientY));
    }
    function finish(event: PointerEvent) {
      const drag = pointerDrag.current;
      pointerDrag.current = null;
      setDraggedCard(null); setDropActive(false);
      if (!drag?.moved) return;
      suppressCardClick.current = true;
      if (insideDropZone(event.clientX, event.clientY)) addFromPointer.current(drag.slug);
      setTimeout(() => { suppressCardClick.current = false; }, 0);
    }
    function cancel() { pointerDrag.current = null; setDraggedCard(null); setDropActive(false); }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
    };
  }, []);

  async function preview() {
    await run('preview', async () => {
      acceptJob(await call('preview', { slugs: selected, name: name.trim() || undefined }));
      setNotice('草案已生成。检查合并内容，处理冲突后即可创建新机器人。');
    });
  }

  const chosen = selected.map((slug) => bots.find((bot) => bot.slug === slug) ?? job?.sources?.find((source: any) => source.slug === slug) ?? { slug });
  const filtered = bots.filter((bot) => `${label(bot)} ${bot.description ?? ''} ${bot.slug}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const conflicts = Array.isArray(job?.conflicts) ? job.conflicts : [];
  const unanswered = conflicts.filter((conflict) => !decisions[conflict.id]).length;
  const created = Boolean(job && (job.newBot || job.bot || job.targetSlug || ACTIVE_STATUSES.has(job.status ?? '')));
  const verified = Boolean(job && (job.status === 'verified' || job.status === 'cleaned' || job.status === 'complete' || job.status === 'completed' || job.verification?.ok === true || job.verification?.passed === true));
  const completed = Boolean(job && ['cleaned', 'complete', 'completed'].includes(job.status ?? ''));
  const analysisRunning = ['analyzing', 'running', 'pending'].includes(job?.analysis?.status ?? '');
  const analysisProposal = job?.analysis?.proposal;
  const editedAnalysis = analysisEdits ?? analysisDraft(analysisProposal);
  const analysisHasConflicts = significantLines(editedAnalysis.conflicts).length > 0;
  const originalAnalysisConflicts = significantLines(analysisDraft(analysisProposal).conflicts);
  const analysisNeedsReview = originalAnalysisConflicts.length > 0 && !conflictsReviewed;
  const proposalKey = `${job?.id ?? ''}:${JSON.stringify(analysisProposal ?? null)}`;
  const analysisMatchesSaved = !analysisProposal || JSON.stringify(editedAnalysis) === JSON.stringify(analysisDraft(analysisProposal));
  const draftCurrent = Boolean(job?.status === 'ready' && (name.trim() || job.name) === job.name && useAnalysis === Boolean(job.useAnalysis) && analysisMatchesSaved && conflicts.every((conflict) => decisions[conflict.id] === job.decisions?.[conflict.id]));
  const isolated = status?.isolated === true || status?.isolatedHome === true || status?.mode === 'isolated' || status?.cleanupEnabled === true;
  const jobSources = (job?.sources ?? chosen).map((source: any) => typeof source === 'string' ? { slug: source } : source);
  const cleanupTargets = list(cleanup, 'targets').length ? list(cleanup, 'targets') : jobSources;
  const expectedAck = cleanup?.acknowledgement ?? cleanup?.expectedAcknowledgement ?? job?.name ?? '';
  const cleanupAllowed = cleanup?.allowed !== false && isolated && Boolean(cleanup?.token);
  const eraseAllowed = cleanupTargets.length > 0 && cleanupTargets.every((target: any) => target.eraseAvailable === true);
  const cleanupExclusions = Array.isArray(cleanup?.exclusions) ? cleanup.exclusions : [];
  const scheduleRows = list(schedulePreview, 'rows');
  const scheduleComplete = job?.scheduleTransfer?.status === 'complete';

  React.useEffect(() => {
    setAnalysisEdits(analysisProposal ? analysisDraft(analysisProposal) : null);
    setConflictsReviewed(job?.analysis?.conflictsReviewed === true);
  }, [proposalKey, job?.analysis?.conflictsReviewed]);

  function revisionPayload() {
    return {
      id: job!.id, decisions, name: name.trim() || job!.name, useAnalysis,
      ...(analysisProposal ? { analysisEdits: { ...editedAnalysis, notes: significantLines(editedAnalysis.notes), conflicts: significantLines(editedAnalysis.conflicts) }, conflictsReviewed } : {}),
    };
  }

  function editAnalysis(field: keyof AnalysisEdits, value: string) {
    const next = field === 'persona' || field === 'memory' ? value : value.split('\n');
    if (field === 'conflicts' && !conflictsReviewed && significantLines(next as string[]).length < originalAnalysisConflicts.length) {
      setError('先勾选“已处理智能整理列出的冲突”，再移除冲突清单中的项目。');
      return;
    }
    setAnalysisEdits({ ...editedAnalysis, [field]: next });
    if (field === 'conflicts' && significantLines(next as string[]).length > 0) setUseAnalysis(false);
  }

  React.useEffect(() => {
    if (!job?.id || !analysisRunning) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    async function poll() {
      try {
        const next = jobOf(await call('getJob', { id: job!.id }, controller.signal));
        if (!disposed && mounted.current) setJob(next);
      } catch (reason) {
        if (!disposed && mounted.current) setError(errorMessage(reason));
      }
      if (!disposed) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 1000);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [job?.id, analysisRunning, call]);

  async function commit() {
    if (!job) return;
    if (!draftCurrent) {
      await run('revise', async () => {
        acceptJob(await call('revise', revisionPayload()));
        setNotice('融合草案已更新。请检查下方完整内容，再确认创建。');
      });
      return;
    }
    await run('commit', async () => {
      acceptJob(await call('commit', { id: job.id }));
      await refresh();
      setNotice('新机器人已创建。验证通过后，可清理原机器人。');
    });
  }

  async function verify() {
    if (!job) return;
    await run('verify', async () => {
      acceptJob(await call('verify', { id: job.id }));
      await refresh();
      setNotice('验证结果已更新。请查看下方检查明细。');
    });
  }

  async function startAnalysis() {
    if (!job || busy || analysisRunning) return;
    const id = job.id;
    setError(null); setAnalysisConsent(false);
    setJob({ ...job, analysis: { status: 'analyzing', provider: status?.provider, model: status?.model } });
    setNotice('智能整理已启动，可以停止，也可以稍后从融合历史查看结果。');
    try {
      const next = jobOf(await call('analyze', { id }));
      if (!mounted.current) return;
      setJobs((existing) => [next, ...existing.filter((item) => item.id !== id)]);
      if (activeJobId.current === id) {
        setJob(next);
        setNotice('智能整理已完成。请先查看建议，再决定是否采用。');
      }
    } catch (reason) {
      if (!mounted.current) return;
      try {
        const latest = jobOf(await call('getJob', { id }));
        if (mounted.current && activeJobId.current === id) setJob(latest);
      } catch { /* The initial operation error remains the actionable message. */ }
      if (mounted.current && activeJobId.current === id) setError(errorMessage(reason));
    }
  }

  function startNew() {
    setJob(null); setSelected([]); setName(''); setDecisions({}); setUseAnalysis(false); setBehaviorConfirmed(false); setAnalysisEdits(null); setConflictsReviewed(false); setError(null); setNotice(null);
  }

  return <div className="ff-root">
    <header className="ff-heading">
      <div><h1>机器人融合</h1><p>把各自积累的规则与记忆，组合成一个新伙伴。</p></div>
      <div className="ff-heading-actions">
        <span className={`ff-environment ${isolated ? 'is-isolated' : ''}`}><span />{status ? (isolated ? '独立工作空间' : '只读来源') : '正在连接'}</span>
        <button type="button" className="ff-button ff-button-quiet" disabled={busy} onClick={() => run('refresh', async () => { await refresh(); setNotice('机器人列表已刷新。'); })} aria-label="刷新机器人列表"><Icon name="refresh" />刷新</button>
      </div>
    </header>

    <div className="ff-live" aria-live="polite" aria-atomic="true">
      {error && <div className="ff-alert ff-alert-error" role="alert"><Icon name="alert" /><div><strong>操作未完成</strong><p>{error}</p></div><button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}>×</button></div>}
      {notice && <div className="ff-alert ff-alert-success"><Icon name="check" /><p>{notice}</p><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button></div>}
    </div>

    <div className="ff-workbench">
      <section className="ff-library" aria-labelledby="ff-library-title">
        <div className="ff-section-heading"><h2 id="ff-library-title">我的机器人<span>{bots.length}</span></h2></div>
        <label className="ff-search"><Icon name="search" /><input type="search" placeholder="搜索名称或专长" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索机器人" /></label>
        {pending === 'load' && <div className="ff-empty"><Spinner /><p>正在读取机器人…</p></div>}
        {pending !== 'load' && bots.length === 0 && <div className="ff-empty"><Icon name="cards" size={34} /><strong>还没有可用的机器人</strong><p>{sources.length ? '从下方来源中导入机器人，再开始融合。' : '连接成功后，这里会显示此工作空间的机器人。'}</p><button type="button" className="ff-button" disabled={busy} onClick={() => run('refresh', () => refresh())}>重新读取</button></div>}
        {bots.length > 0 && filtered.length === 0 && <div className="ff-empty"><p>没有找到“{query}”。</p><button type="button" className="ff-text-button" onClick={() => setQuery('')}>清除搜索</button></div>}
        <div className="ff-bot-grid">
          {filtered.map((bot) => {
            const isSelected = selected.includes(bot.slug);
            const protectedBot = bot.protected || bot.slug.toLowerCase() === 'tob';
            return <button type="button" key={bot.slug} className={`ff-bot-card ${isSelected ? 'is-selected' : ''}`} draggable={false} disabled={busy || protectedBot} aria-pressed={isSelected} aria-label={`${label(bot)}，${protectedBot ? '受保护' : isSelected ? '从融合台移除' : '加入融合台'}`} onPointerDown={(event) => { if (event.pointerType === 'mouse' && event.button === 0 && !busy && !protectedBot) pointerDrag.current = { slug: bot.slug, x: event.clientX, y: event.clientY, moved: false }; }} onClick={() => { if (!suppressCardClick.current) isSelected ? remove(bot.slug) : add(bot.slug); }}>
              <span className="ff-card-top"><span className="ff-card-mark">{protectedBot ? <Icon name="lock" size={13} /> : isSelected ? <Icon name="check" size={13} /> : '+'}</span></span>
              <Avatar bot={bot} />
              <strong>{label(bot)}</strong>
              <span className="ff-card-description">{protectedBot ? '内置机器人 · 受保护' : bot.description || (Array.isArray(bot.roles) && bot.roles.length ? bot.roles.join('、') : '规则与记忆可参与融合')}</span>
              <span className="ff-card-footer">{protectedBot ? '不可参与融合' : isSelected ? '已加入融合台' : '拖动或点选加入'}</span>
            </button>;
          })}
        </div>

        {sources.length > 0 && <details className="ff-import">
          <summary>从原工作空间导入<span>{sources.length}</span></summary>
          <p>导入一份副本到此工作空间，原机器人保留。</p>
          <div className="ff-import-list">{sources.map((source) => <div key={source.slug} className="ff-import-row"><Avatar bot={source} small /><span>{label(source)}</span><button type="button" className="ff-button ff-button-small" disabled={busy || source.protected || source.slug.toLowerCase() === 'tob'} onClick={() => run(`import:${source.slug}`, async () => { await call('importSource', { slug: source.slug }); await refresh(); setNotice(`已导入 ${label(source)} 的副本。`); })}>{pending === `import:${source.slug}` ? '导入中…' : '导入副本'}</button></div>)}</div>
        </details>}
      </section>

      <section className="ff-forge" aria-labelledby="ff-forge-title">
        <div className="ff-section-heading"><h2 id="ff-forge-title">融合台</h2>{(job || selected.length > 0) && <button type="button" className="ff-text-button" disabled={busy} onClick={startNew}>新建融合</button>}</div>
        <div ref={dropZoneRef} className={`ff-dropzone ${dropActive ? 'is-over' : ''} ${chosen.length ? 'has-cards' : ''}`}>
          {chosen.length > 0 ? <div className="ff-slots">{chosen.map((bot, index) => <React.Fragment key={bot.slug}>{index > 0 && <span className="ff-slot-plus" aria-hidden="true">+</span>}<div className="ff-slot"><button type="button" className="ff-slot-remove" disabled={busy} onClick={() => remove(bot.slug)} aria-label={`移除 ${label(bot)}`}>×</button><Avatar bot={bot} /><strong>{label(bot)}</strong></div></React.Fragment>)}{chosen.length === 1 && <><span className="ff-slot-plus" aria-hidden="true">+</span><div className="ff-slot ff-slot-empty"><Icon name="plus" size={30} /><span>再选一个</span></div></>}</div> : <div className="ff-drop-hint"><div className="ff-empty-cards"><Icon name="cards" size={48} /></div><strong>把机器人放到这里</strong><p>拖入两个或更多机器人，<br />也可以点选左侧卡牌。</p></div>}
          <span className="ff-drop-caption">{selected.length ? `已选择 ${selected.length} 个机器人` : '至少选择 2 个机器人'}</span>
        </div>

        <div className="ff-result-connector" aria-hidden="true"><span /><Icon name="merge" size={24} /><span /></div>
        <div className={`ff-result-avatar ${busy && ['preview', 'commit'].includes(pending ?? '') ? 'is-working' : ''}`}>
          {job ? <Avatar bot={{ ...job, displayName: job.name, avatarDataUrl: job.avatarDataUrl ?? job.avatar?.dataUrl }} large /> : <div className="ff-avatar ff-avatar-large ff-avatar-unknown">?</div>}
          <span>{job ? (created ? '新机器人' : '新机器人草案') : '等待融合'}</span>
          {job && !created && <button type="button" className="ff-text-button" disabled={busy || analysisRunning} onClick={() => run('avatar', async () => { acceptJob(await call('revise', { ...revisionPayload(), regenerateAvatar: true })); setNotice('已随机生成新的头像。'); })}>换一个随机头像</button>}
        </div>
        <label className="ff-field"><span>新机器人名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="为融合后的伙伴取个名字" maxLength={80} disabled={busy || created} /></label>
        <p className="ff-hint ff-avatar-hint">头像在生成草案时随机生成，并随新机器人保存。</p>
        <button type="button" className="ff-button ff-button-primary ff-preview-button" disabled={busy || selected.length < 2 || !name.trim() || created} onClick={preview}>{pending === 'preview' ? <><Spinner />正在生成草案…</> : <><Icon name="merge" />{job ? '重新生成草案' : '预览融合'}</>}</button>
        {selected.length >= 2 && !name.trim() && <p className="ff-hint ff-preserve-hint">先为新机器人取个名字。</p>}
        <p className="ff-hint ff-preserve-hint"><Icon name="shield" size={14} />创建成功前，原机器人保持原样。</p>
      </section>

      <section className="ff-review" aria-labelledby="ff-review-title">
        <div className="ff-section-heading"><h2 id="ff-review-title">{created ? '融合结果' : '融合草案'}</h2>{job && <span className={`ff-badge ${verified ? 'is-success' : ''}`}>{names[job.status ?? ''] ?? job.status ?? '待确认'}</span>}</div>
        {!job ? <div className="ff-review-empty"><Icon name="document" size={42} /><strong>先看看将会合成什么</strong><p>生成草案后，你可以检查规则、记忆文档与冲突，确认后再创建。</p><div className="ff-empty-sequence"><span>选择伙伴</span><Icon name="chevron" size={15} /><span>检查草案</span><Icon name="chevron" size={15} /><span>创建新伙伴</span></div></div> : <>
          <div className="ff-draft-heading"><Avatar bot={{ ...job, displayName: job.name }} small /><div><h3>{name || job.name || '新机器人'}</h3><p>融合自 {jobSources.map(label).join('、')}</p></div></div>
          {job.summary && <div className="ff-summary">{typeof job.summary === 'string' ? job.summary : <JsonDetails value={job.summary} />}</div>}
          {Array.isArray(job.warnings) && job.warnings.length > 0 && <div className="ff-warning"><Icon name="alert" size={16} /><div>{job.warnings.map((warning: any, index: number) => <p key={index}>{typeof warning === 'string' ? warning : warning.message ?? JSON.stringify(warning)}</p>)}</div></div>}
          {Array.isArray(job.standingWarnings) && job.standingWarnings.length > 0 && <div className="ff-warning"><Icon name="document" size={16} /><div><strong>常驻上下文已精简</strong>{job.standingWarnings.map((warning: string, index: number) => <p key={index}>{warning}</p>)}</div></div>}
          <DraftContent job={job} />
          <SourceArchives job={job} />

          {!created && <div className="ff-analysis">
            <div className="ff-analysis-heading"><div><h3>智能整理</h3><p>{status?.modelAvailable === false ? '配置模型服务后，即可整理规则与记忆。' : '让当前模型归纳规则与记忆，再决定是否采用。'}</p></div><button type="button" className="ff-button ff-button-small" disabled={busy || analysisRunning || status?.modelAvailable === false} onClick={() => setAnalysisConsent(true)}>{analysisRunning ? <><Spinner />整理中</> : '智能整理'}</button></div>
            {analysisRunning && <div className="ff-analysis-running"><p>正在整理，完成后结果会保存在此任务中。</p><button type="button" className="ff-text-button" disabled={busy} onClick={() => run('cancelAnalyze', async () => { await call('cancelAnalyze', { id: job.id }); setJob(jobOf(await call('getJob', { id: job.id }))); setNotice('已请求停止智能整理。'); })}>停止整理</button></div>}
            {job.analysis?.error && <div className="ff-warning"><p>{typeof job.analysis.error === 'string' ? job.analysis.error : job.analysis.error.message}</p></div>}
            {analysisProposal && <>
              <details className="ff-document ff-analysis-editor" open><summary><Icon name="document" size={16} /><span>检查并编辑整理建议</span></summary>
                <div className="ff-analysis-fields">
                  <label className="ff-field"><span>机器人规则</span><textarea value={editedAnalysis.persona} onChange={(event) => editAnalysis('persona', event.target.value)} disabled={busy || analysisRunning} rows={7} maxLength={65536} /></label>
                  <label className="ff-field"><span>长期记忆</span><textarea value={editedAnalysis.memory} onChange={(event) => editAnalysis('memory', event.target.value)} disabled={busy || analysisRunning} rows={7} maxLength={131072} /></label>
                  <label className="ff-field"><span>整理说明（每行一项）</span><textarea value={editedAnalysis.notes.join('\n')} onChange={(event) => editAnalysis('notes', event.target.value)} disabled={busy || analysisRunning} rows={3} /></label>
                  {(originalAnalysisConflicts.length > 0 || job.analysis?.conflictsReviewed) && <label className="ff-checkbox"><input type="checkbox" checked={conflictsReviewed} disabled={busy || analysisRunning} onChange={(event) => {
                    const reviewed = event.target.checked;
                    setConflictsReviewed(reviewed);
                    if (!reviewed && significantLines(editedAnalysis.conflicts).length < originalAnalysisConflicts.length) { setAnalysisEdits({ ...editedAnalysis, conflicts: originalAnalysisConflicts }); setUseAnalysis(false); }
                  }} /><span><strong>已处理智能整理列出的冲突</strong><small>先在上方规则与记忆中处理矛盾，再确认并移除对应冲突。</small></span></label>}
                  <label className="ff-field"><span>待确认冲突（每行一项）</span><textarea value={editedAnalysis.conflicts.join('\n')} onChange={(event) => editAnalysis('conflicts', event.target.value)} disabled={busy || analysisRunning} rows={3} placeholder="没有未解决的冲突" /></label>
                  {!analysisMatchesSaved && <p className="ff-hint">编辑尚未保存。点击“更新融合草案”，再检查完整合并内容。</p>}
                </div>
              </details>
              <label className="ff-checkbox"><input type="checkbox" checked={useAnalysis} onChange={(event) => setUseAnalysis(event.target.checked)} disabled={busy || analysisRunning || analysisHasConflicts || analysisNeedsReview} /><span><strong>采用整理结果</strong><small>{analysisHasConflicts ? '先处理上方仍列出的事实冲突。' : analysisNeedsReview ? '请先确认已经处理智能整理列出的冲突。' : '使用已检查的整理内容生成新机器人规则与记忆。'}</small></span></label>
            </>}
          </div>}

          {conflicts.length > 0 && <div className="ff-conflicts"><h3>需要你决定<span>{unanswered > 0 ? `${unanswered} 项待处理` : '已全部选择'}</span></h3>{conflicts.map((conflict) => <fieldset key={conflict.id} className="ff-conflict" disabled={busy || created}><legend>{conflict.title ?? conflict.path ?? '内容冲突'}</legend>{conflict.description && <p>{conflict.description}</p>}<div className="ff-conflict-options">{(conflict.options?.length ? conflict.options : [{ id: 'merge', label: '保留全部来源内容' }]).map((option) => <label key={option.id} className={decisions[conflict.id] === option.id ? 'is-selected' : ''}><input type="radio" name={`conflict-${conflict.id}`} checked={decisions[conflict.id] === option.id} onChange={() => setDecisions((current) => ({ ...current, [conflict.id]: option.id }))} /><span><strong>{option.label ?? option.id}</strong>{option.body && <small>{option.body}</small>}</span></label>)}</div></fieldset>)}</div>}

          {created && <Verification job={job} />}
          {job.scheduleTransfer && <ScheduleTransferResult value={job.scheduleTransfer} />}
          {job.cleanup?.results?.length > 0 && <div className="ff-cleanup-results"><h3>清理进度</h3><ul>{Array.from(new Map<string, any>(job.cleanup.results.map((result: any) => [result.slug, result])).values()).map((result) => <li key={result.slug} className={result.ok ? 'is-success' : 'is-error'}><Icon name={result.ok ? 'check' : 'alert'} size={15} /><div><strong>{result.displayName ?? result.slug}</strong><p>{result.ok ? '已清理' : result.error ?? '尚未清理，可重试'}</p></div></li>)}</ul></div>}
          {created && verified && !completed && <label className="ff-checkbox"><input type="checkbox" checked={behaviorConfirmed} disabled={busy} onChange={(event) => setBehaviorConfirmed(event.target.checked)} /><span><strong>已在新机器人中验证主要能力</strong><small>回到聊天，实际检查核心规则与工作能力，再确认清理。</small></span></label>}
          {job.error && <div className="ff-warning"><Icon name="alert" /><p>{typeof job.error === 'string' ? job.error : job.error.message ?? JSON.stringify(job.error)}</p></div>}

          <div className="ff-review-actions">
            {!created ? <>
              <button type="button" className="ff-button ff-button-primary" disabled={busy || analysisRunning || unanswered > 0 || (useAnalysis && (analysisHasConflicts || analysisNeedsReview))} onClick={commit}>{pending === 'commit' ? <><Spinner />正在创建…</> : pending === 'revise' ? <><Spinner />正在更新…</> : <><Icon name={draftCurrent ? 'check' : 'document'} />{draftCurrent ? '确认并创建机器人' : '更新融合草案'}</>}</button>
              {unanswered > 0 && <p className="ff-hint">先处理 {unanswered} 项冲突。</p>}
              <button type="button" className="ff-text-button" disabled={busy || analysisRunning} onClick={() => run('revise', async () => { acceptJob(await call('revise', revisionPayload())); setNotice('草案已保存，可从融合历史中继续。'); })}>保存草案</button>
            </> : <>
              <button type="button" className="ff-button ff-button-primary" disabled={busy || completed} onClick={verify}>{pending === 'verify' ? <><Spinner />正在验证…</> : <><Icon name="shield" />{verified ? '重新验证' : '验证新机器人'}</>}</button>
              <button type="button" className="ff-button" disabled={busy || !verified || completed || !isolated || !behaviorConfirmed || scheduleComplete} onClick={() => run('schedulePreview', async () => {
                const transfer = job.scheduleTransfer;
                const recovering = transfer && transfer.status !== 'complete';
                const result = recovering ? { token: 'resume', rows: transfer.rows, recovering: true, reason: transfer.recovery ?? '继续上次已经确认的迁移范围，不新增例程，也不会立即补跑。' } : await call('schedulePreview', { id: job.id, behaviorConfirmed: true });
                setSchedulePreview(result); setSelectedSchedules(recovering ? list(transfer, 'rows').map((row) => row.key) : []); setScheduleAcknowledgement('');
              })}>{scheduleComplete ? `已迁移 ${list(job.scheduleTransfer, 'rows').length} 项例程` : job.scheduleTransfer ? '重试已选例程' : '迁移选定例程'}</button>
              <button type="button" className="ff-button ff-button-danger" disabled={busy || !verified || completed || !isolated || !behaviorConfirmed} onClick={() => run('cleanupPreview', async () => {
                const result = await call('cleanupPreview', { id: job.id, behaviorConfirmed: true });
                setCleanup(result); setAcknowledgement(''); setEraseMemory(false); setAcknowledgeUnmigrated(false);
              })}>{completed ? '原机器人已清理' : '清理原机器人'}</button>
              {!isolated && <p className="ff-hint">此连接只读，不提供清理操作。</p>}
              {!verified && !completed && <p className="ff-hint">验证通过后，才能清理原机器人。</p>}
            </>}
          </div>
          <details className="ff-provenance"><summary>来源与任务记录</summary><dl><dt>任务</dt><dd>{job.id}</dd>{job.createdAt && <><dt>创建时间</dt><dd>{dateLabel(job.createdAt)}</dd></>}{jobSources.map((source: any, index: number) => <React.Fragment key={source.slug ?? index}><dt>{label(source)}</dt><dd>{source.slug}{source.head && <small>快照 {source.head.slice(0, 12)}</small>}</dd></React.Fragment>)}</dl></details>
        </>}
      </section>
    </div>

    <section className="ff-history" aria-labelledby="ff-history-title"><div className="ff-section-heading"><h2 id="ff-history-title">融合历史<span>{jobs.length}</span></h2><span className="ff-hint">草案与中断的任务都可以继续</span></div>{jobs.length === 0 ? <p className="ff-history-empty">完成第一次预览后，任务会自动保存在这里。</p> : <div className="ff-history-list">{jobs.map((item) => <button type="button" key={item.id} className={`ff-history-item ${job?.id === item.id ? 'is-current' : ''}`} disabled={busy} onClick={() => run('restore', async () => { acceptJob(await call('getJob', { id: item.id })); setNotice('已恢复融合任务。'); })}><Avatar bot={{ ...item, displayName: item.name }} small /><span className="ff-history-name"><strong>{item.name || '未命名融合'}</strong><small>{dateLabel(item.updatedAt ?? item.createdAt) || item.id.slice(0, 12)}</small></span><span className={`ff-badge ${['verified', 'cleaned', 'complete', 'completed'].includes(item.status ?? '') ? 'is-success' : ''}`}>{names[item.status ?? ''] ?? item.status ?? '待确认'}</span><Icon name="chevron" size={16} /></button>)}</div>}</section>

    {draggedCard && <div className="ff-dragged-card" aria-hidden="true" style={{ left: draggedCard.x + 14, top: draggedCard.y + 12 }}><Avatar bot={bots.find((bot) => bot.slug === draggedCard.slug) ?? { slug: draggedCard.slug }} small /><strong>{label(bots.find((bot) => bot.slug === draggedCard.slug) ?? { slug: draggedCard.slug })}</strong></div>}
    {busy && pending !== 'load' && <div className="ff-operation-status" role="status"><Spinner />{({ refresh: '正在刷新', restore: '正在恢复任务', preview: '正在生成融合草案', revise: '正在保存草案', commit: '正在创建新机器人', verify: '正在验证', schedulePreview: '正在读取来源例程', migrateSchedules: '正在迁移所选例程', cleanupPreview: '正在检查清理范围', cleanup: '正在清理原机器人' } as Record<string, string>)[pending ?? ''] ?? '正在处理'}…</div>}

    {schedulePreview && <Modal title={schedulePreview.recovering ? '重试已确认的例程迁移' : '迁移选定例程'} onClose={() => { if (!busy) setSchedulePreview(null); }}>
      {error && <div className="ff-alert ff-alert-error" role="alert"><p>{error}</p></div>}
      <p className="ff-modal-description">{schedulePreview.reason || '选择需要迁入新机器人的例程。未选择的例程保留在来源中，不会立即补跑。'}</p>
      {schedulePreview.recovering && <div className="ff-warning"><p>本次只继续上次已确认的 {scheduleRows.length} 项例程。需要改变范围时，先在原生例程页核对并处理。</p></div>}
      {job?.scheduleTransfer?.recovery && <div className="ff-warning"><div><strong>恢复状态</strong><p>{job.scheduleTransfer.recovery}</p></div></div>}
      {scheduleRows.length === 0 ? <div className="ff-empty"><Icon name="schedule" size={30} /><strong>来源机器人没有例程</strong><p>无需迁移，关闭即可继续检查融合结果。</p></div> : <div className="ff-schedule-list">{scheduleRows.map((row: any) => <label className={`ff-schedule-row ${row.blocked ? 'is-blocked' : ''}`} key={row.key}>
        <input type="checkbox" checked={selectedSchedules.includes(row.key)} disabled={busy || row.blocked || schedulePreview.recovering} onChange={(event) => setSelectedSchedules((current) => event.target.checked ? [...current, row.key] : current.filter((key) => key !== row.key))} />
        <span><strong>{row.title || '未命名例程'}</strong><small>来源：{row.sourceName ?? row.sourceSlug}；原状态：{row.enabled ? '已启用' : '已暂停'}</small><ScheduleTrigger value={row.trigger} />{row.prompt && <details><summary>查看例程指令</summary><pre>{row.prompt}</pre></details>}{row.blocked && <em>{row.reason || '当前例程不可迁移'}</em>}</span>
      </label>)}</div>}
      {scheduleRows.length > 0 && <><p className="ff-hint">已选择 {selectedSchedules.length} 项。迁移成功后，请在新机器人中复核例程及所需权限。</p><label className="ff-field"><span>输入“{job?.name}”以确认迁移</span><input value={scheduleAcknowledgement} onChange={(event) => setScheduleAcknowledgement(event.target.value)} disabled={busy} autoComplete="off" /></label></>}
      <div className="ff-modal-actions"><button type="button" className="ff-button" disabled={busy} onClick={() => setSchedulePreview(null)}>暂不迁移</button>{scheduleRows.length > 0 && <button type="button" className="ff-button ff-button-primary" disabled={busy || selectedSchedules.length === 0 || scheduleAcknowledgement !== job?.name} onClick={() => run('migrateSchedules', async () => {
        try {
          acceptJob(await call('migrateSchedules', { id: job!.id, token: schedulePreview.token, selectedKeys: selectedSchedules, acknowledgement: scheduleAcknowledgement }));
          setSchedulePreview(null); await refresh(); setNotice('所选例程已迁移。原启用状态与时区已保留，请回到新机器人复核。');
        } catch (reason) {
          try { setJob(jobOf(await call('getJob', { id: job!.id }))); } catch { /* Preserve the original migration error. */ }
          throw reason;
        }
      })}>{pending === 'migrateSchedules' ? <><Spinner />正在迁移…</> : schedulePreview.recovering ? '重试已确认范围' : '确认迁移所选例程'}</button>}</div>
    </Modal>}

    {cleanup && <Modal title="清理原机器人" onClose={() => { if (!busy) setCleanup(null); }}>
      {error && <div className="ff-alert ff-alert-error" role="alert"><p>{error}</p></div>}
      <p className="ff-modal-description">新机器人已经验证。清理后，下列原机器人会从此独立工作空间移除。</p>
      <ul className="ff-cleanup-targets">{cleanupTargets.map((target: any, index: number) => <li key={target.slug ?? index}><Icon name="cards" size={17} /><div><strong>{typeof target === 'string' ? target : label(target)}</strong><DependencyDetails value={target.dependencies} /><p className="ff-erase-status">{target.eraseAvailable === true ? '可选择同时删除该机器人的记忆文件。' : target.eraseAvailable === false ? '此机器人的记忆文件必须保留。' : '服务未确认记忆文件可删除，本次保留。'}</p></div></li>)}</ul>
      {cleanup.reason && <div className="ff-warning"><p>{cleanup.reason}</p></div>}
      <section className="ff-unmigrated"><h3>尚未迁入新机器人的资料</h3>{cleanupExclusions.length > 0 ? <ul>{cleanupExclusions.map((item: any, index: number) => <li key={index}>{typeof item === 'string' ? item : item.label ?? item.name ?? JSON.stringify(item)}</li>)}</ul> : <p>本次预览未列出其他未迁入资料。</p>}<p className="ff-hint">清理会影响上方列出的关联项。需要保留或迁移时，请先取消清理并处理。</p></section>
      {!cleanupAllowed && <div className="ff-warning"><p>当前任务不满足清理条件，请返回检查验证结果与工作空间状态。</p></div>}
      <label className="ff-checkbox"><input type="checkbox" checked={acknowledgeUnmigrated} onChange={(event) => setAcknowledgeUnmigrated(event.target.checked)} disabled={busy || !cleanupAllowed} /><span><strong>已了解上述未迁入资料与依赖影响</strong><small>确认所需资料已经保留，且可以结束原机器人的关联活动。</small></span></label>
      <label className="ff-checkbox"><input type="checkbox" checked={eraseMemory} onChange={(event) => setEraseMemory(event.target.checked)} disabled={busy || !cleanupAllowed || !eraseAllowed} /><span><strong>同时删除原机器人的记忆文件</strong><small>{eraseAllowed ? '这是永久操作。融合记录保留用于追溯。' : '部分机器人未获准删除记忆，本次保留所有来源记忆文件。'}</small></span></label>
      <label className="ff-field"><span>输入“{expectedAck || '确认清理'}”以确认</span><input value={acknowledgement} onChange={(event) => setAcknowledgement(event.target.value)} disabled={busy || !cleanupAllowed} autoComplete="off" /></label>
      <div className="ff-modal-actions"><button type="button" className="ff-button" disabled={busy} onClick={() => setCleanup(null)}>保留原机器人</button><button type="button" className="ff-button ff-button-danger-solid" disabled={busy || !cleanupAllowed || !acknowledgeUnmigrated || acknowledgement !== (expectedAck || '确认清理')} onClick={() => run('cleanup', async () => { acceptJob(await call('cleanup', { id: job!.id, token: cleanup.token, eraseMemory: eraseMemory && eraseAllowed, acknowledgement, acknowledgeUnmigrated })); setCleanup(null); await refresh(); setNotice('清理结果已保存。'); })}>{pending === 'cleanup' ? <><Spinner />正在清理…</> : '确认清理'}</button></div>
    </Modal>}
    {analysisConsent && <Modal title="使用当前模型整理" onClose={() => { if (!busy) setAnalysisConsent(false); }}>{error && <div className="ff-alert ff-alert-error" role="alert"><p>{error}</p></div>}<p className="ff-modal-description">参与融合的规则与记忆文本将提交给当前配置的模型服务，生成一份整理建议。整理过程不执行工具，也不会直接修改机器人。</p><dl className="ff-model-info"><dt>模型服务</dt><dd>{status?.llm?.provider ?? status?.provider ?? job?.analysis?.provider ?? '当前配置的服务'}</dd><dt>模型</dt><dd>{status?.llm?.model ?? status?.model ?? job?.analysis?.model ?? '当前默认模型'}</dd></dl><p className="ff-hint">整理完成后，先查看建议，再勾选“采用整理结果”。</p><div className="ff-modal-actions"><button type="button" className="ff-button" disabled={busy} onClick={() => setAnalysisConsent(false)}>暂不整理</button><button type="button" className="ff-button ff-button-primary" disabled={busy || !job} onClick={startAnalysis}>提交资料并整理</button></div></Modal>}
  </div>;
}

function Avatar({ bot, small = false, large = false }: { bot: any; small?: boolean; large?: boolean }) {
  const src = avatarOf(bot);
  const title = label(bot);
  const slug = bot.slug ?? bot.id ?? title;
  const color = String(slug).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
  return <span className={`ff-avatar ff-avatar-${color} ${small ? 'ff-avatar-small' : ''} ${large ? 'ff-avatar-large' : ''}`}>{src ? <img src={src} alt={`${title}的头像`} draggable={false} /> : <span aria-hidden="true">{Array.from(title.trim())[0] || '◇'}</span>}</span>;
}

function ScheduleTrigger({ value }: { value: any }) {
  if (!value || typeof value !== 'object') return <small>触发时间未提供，请在原生例程页核对。</small>;
  const weekdays: Record<number, string> = { 0: '日', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };
  const description = value.kind === 'daily' ? `每天 ${value.time}` : value.kind === 'weekly' ? `每周 ${(value.weekdays ?? []).map((day: number) => weekdays[day] ?? day).join('、')} ${value.time}` : value.kind === 'once' ? `${value.date} ${value.time}（一次）` : value.kind === 'cron' ? `自定义时间：${value.expression}` : value.kind === 'every' ? `每 ${value.everySeconds} 秒` : '其他触发方式';
  return <><small>{description}</small><small>时区：{value.timeZone ?? (value.kind === 'every' ? '按固定间隔，无时区' : '未提供，请在原生例程页核对')}</small></>;
}

function ScheduleTransferResult({ value }: { value: any }) {
  const complete = value.status === 'complete';
  const rows = list(value, 'rows');
  return <div className={complete ? 'ff-verification is-passed' : 'ff-warning'}><Icon name={complete ? 'check' : 'alert'} /><div><strong>{complete ? `已迁移 ${rows.length} 项例程` : '例程切换尚未完成'}</strong>{value.error && <p>{value.error}</p>}{value.recovery && <p>{value.recovery}</p>}{complete && <p>保留原启用状态与时区，未立即补跑。请在新机器人内复核。</p>}</div></div>;
}

function SourceArchives({ job }: { job: Job }) {
  const archives = list(job.archives, 'archives');
  if (!archives.length && job.archivalComplete === undefined) return null;
  const coverageNames: Record<string, string> = { git: 'Git 历史', sessions: '聊天会话', attachments: 'Session 附件', nativeBotUploads: 'Bot 上传', channels: '频道消息', uploadSessionAssociation: '附件与会话的关联', nativeChannels: '频道消息', sessionAssociation: '会话关联范围', opaqueEventPayloads: '其他插件事件', workingTree: '当前文件' };
  const coverageText = (key: string, text: unknown) => key === 'channels' ? '保留来源参与、且你当前能看到的完整频道消息。看不到的频道会单独列出，不扩大访问范围。' : key === 'uploadSessionAssociation' ? '保留每份上传所属的频道、消息和可追溯的原始事件记录，同时列出同一机器人的会话。这些关联不能证明某个会话已读取某份文件。' : String(text);
  return <details className="ff-document ff-source-archives"><summary><Icon name="archive" size={16} /><span>来源档案</span><small>{archives.length} 个来源</small></summary><div className="ff-archive-content"><p className="ff-hint">原始会话与历史作为独立档案保留，不拼接为新的原生会话。</p>{job.archivalComplete === false && <div className="ff-warning"><p>来源档案尚未全部完成，请保留来源并重新更新草案。</p></div>}{archives.map((archive: any) => {
    const sessionAttachments = list(archive.attachments, 'attachments').length;
    const nativeUploads = list(archive.nativeBotUploads, 'nativeBotUploads').length;
    const channels = list(archive.channels, 'channels');
    const visibleChannels = channels.filter((channel) => channel.visibility === 'visible');
    const hiddenChannels = channels.length - visibleChannels.length;
    const channelMessages = visibleChannels.reduce((count, channel) => count + (Number.isSafeInteger(channel.messageCount) ? channel.messageCount : 0), 0);
    return <section key={archive.slug}><h4>{label(job.sources?.find((source) => source.slug === archive.slug) ?? archive)}</h4><div className="ff-archive-counts"><span>Git 历史：{archive.git?.verified === true ? '已校验' : '待校验'}</span><span>{list(archive.sessions, 'sessions').length} 个会话</span><span>{sessionAttachments + nativeUploads} 份附件</span><span>Bot 上传 {nativeUploads} 份</span><span>Session 附件 {sessionAttachments} 份</span><span>可见频道 {visibleChannels.length} 个，{channelMessages} 条消息</span></div>{archive.serializationVersion !== 2 && <div className="ff-warning"><p>此较早任务未包含完整 Bot 频道上传档案。请保留来源并重新预览。</p></div>}{hiddenChannels > 0 && <div className="ff-warning"><p>{hiddenChannels} 个关联频道在当前身份下不可见，仅保留频道与可见性记录，未计入已归档消息。</p></div>}{archive.coverage && <dl>{Object.entries(archive.coverage).map(([key, text]) => <React.Fragment key={key}><dt>{coverageNames[key] ?? key}</dt><dd>{coverageText(key, text)}</dd></React.Fragment>)}</dl>}{Array.isArray(archive.unknowns) && archive.unknowns.length > 0 && <div className="ff-warning"><p>{archive.unknowns.map(String).join('；')}</p></div>}</section>;
  })}</div></details>;
}

function DependencyDetails({ value }: { value: unknown }) {
  const labels: Record<string, string> = { sessions: '聊天会话', workspaces: '工作区', grants: '授权与工具规则', identities: '外部联系身份', channels: '参与频道' };
  if (value === undefined || value === null) return <p className="ff-dependency-empty">服务未提供关联项详情，请确认后再清理。</p>;
  const entries = Array.isArray(value) ? [['关联项', value] as const] : typeof value === 'object' ? Object.entries(value) : [['关联项', [value]] as const];
  const populated = entries.map(([key, items]) => [key, Array.isArray(items) ? items : [items]] as const).filter(([, items]) => items.length > 0);
  if (!populated.length) return <p className="ff-dependency-empty">原生服务未发现关联依赖。</p>;
  return <div className="ff-dependencies">{populated.map(([key, items]) => <details key={key}><summary>{labels[key] ?? key}<span>{items.length} 项</span></summary><ul>{items.map((item: any, index) => <li key={index}>{typeof item === 'string' ? item : typeof item === 'object' && item ? item.displayName ?? item.name ?? item.id ?? JSON.stringify(item) : String(item)}</li>)}</ul></details>)}</div>;
}

function DraftContent({ job }: { job: Job }) {
  const files = Array.isArray(job.files) ? job.files : job.files && typeof job.files === 'object' ? Object.entries(job.files).map(([path, value]) => ({ path, content: typeof value === 'string' ? value : (value as any)?.content })) : [];
  const persona = job.persona ?? job.preview?.persona;
  const coreMemory = job.coreMemory ?? job.preview?.coreMemory;
  const documents = [...(typeof persona === 'string' && persona ? [{ path: '机器人规则', content: persona }] : []), ...(typeof coreMemory === 'string' && coreMemory ? [{ path: '核心记忆', content: coreMemory }] : []), ...files.filter((file: any) => !(persona && file.path === 'SOUL.md') && !(coreMemory && file.path === 'MEMORY.md'))];
  return <div className="ff-draft-documents">{documents.length > 0 ? documents.map((file: any, index: number) => <details key={`${file.path ?? file.name}-${index}`} className="ff-document" open={index === 0}><summary><Icon name="document" size={16} /><span>{file.path ?? file.name ?? `文档 ${index + 1}`}</span>{typeof (file.bytes ?? file.size) === 'number' && <small>{(file.bytes ?? file.size).toLocaleString()} 字节</small>}</summary><pre>{file.encoding === 'base64' ? `二进制文件，已纳入融合${typeof file.size === 'number' ? `，共 ${file.size.toLocaleString()} 字节` : ''}。` : file.content ?? file.body ?? file.text ?? '此文档已纳入融合。'}</pre></details>) : <p className="ff-hint">处理版本选择后，点击“更新融合草案”可查看完整合并内容。</p>}{job.manifest && <details className="ff-document"><summary><Icon name="document" size={16} /><span>合并清单</span></summary><JsonDetails value={job.manifest} /></details>}</div>;
}

function Verification({ job }: { job: Job }) {
  const verification = job.verification;
  if (!verification) return <div className="ff-verification"><Icon name="shield" /><div><strong>等待验证</strong><p>检查新机器人与记忆文件后，再清理原机器人。</p></div></div>;
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  const passed = verification.ok === true || verification.passed === true || job.status === 'verified' || job.status === 'cleaned';
  return <div className={`ff-verification ${passed ? 'is-passed' : 'is-failed'}`}><Icon name={passed ? 'check' : 'alert'} /><div><strong>{passed ? '资料回读通过' : '验证尚未通过'}</strong>{verification.message && <p>{verification.message}</p>}{verification.scope && <p>{verification.scope}</p>}{typeof verification.filesChecked === 'number' && <p>已检查 {verification.filesChecked} 份文件。</p>}{checks.length ? <ul>{checks.map((check: any, index: number) => <li key={index}><span>{check.ok === true || check.passed === true ? '✓' : '!'}</span>{check.label ?? check.name ?? check.message ?? String(check)}</li>)}</ul> : !verification.scope && <p>{passed ? '新机器人与融合文件通过检查。' : '请检查任务明细，处理问题后重新验证。'}</p>}{Array.isArray(verification.failures) && verification.failures.length > 0 && <ul>{verification.failures.map((failure: string) => <li key={failure}><span>!</span>{failure}</li>)}</ul>}</div></div>;
}

function JsonDetails({ value }: { value: unknown }) { return <pre className="ff-json">{JSON.stringify(value, null, 2)}</pre>; }
function Spinner() { return <span className="ff-spinner" aria-hidden="true" />; }

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const id = React.useId();
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    (dialog?.querySelector('button, input') as HTMLElement | null)?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== 'Tab' || !dialog) return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="ff-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={ref} className="ff-modal" role="dialog" aria-modal="true" aria-labelledby={id}><header><h2 id={id}>{title}</h2><button type="button" className="ff-close" aria-label="关闭对话框" onClick={onClose}>×</button></header>{children}</div></div>;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 8a7 7 0 0 1 11.6-3L20 8M4 16l2.9 3A7 7 0 0 0 18.5 16" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    cards: <><rect x="3" y="5" width="10" height="15" rx="2" transform="rotate(-9 3 5)" /><path d="m14 4 6 1a2 2 0 0 1 1.6 2.3l-2 12a2 2 0 0 1-2.3 1.6l-3-.5M7 10h3m-3 4h2" /></>,
    document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h6" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z" /><path d="m8 12 3 3 5-6" /></>,
    merge: <><path d="M5 3v5l7 5v8M19 3v5l-7 5M8 17l4 4 4-4" /></>,
    alert: <><path d="m12 3 10 18H2zM12 9v5M12 17h.01" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" /></>,
    schedule: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    archive: <><rect x="3" y="3" width="18" height="4" rx="1" /><path d="M5 7v14h14V7M9 11h6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.cards}</svg>;
}
