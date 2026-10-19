const { reconcile } = require('./findings');
const defaultStore = require('./store');

function completeReview(result, context, store = defaultStore) {
  if (!result || result.paused || result.failed || !context || context.parent !== true) return result;
  if (context.persistedResult) return context.persistedResult;
  const { folder, reviewId, title, historyKind, noiseLevel } = context;
  const persistenceWarnings = [];
  const coverageNotices = [...(result.coverageNotices || [])];
  let checklist;
  /** @type {import('./findingModel').Finding[]} */
  let snapshot = [];
  /** @type {Array<Record<string,unknown>>} */
  let verificationResults = [];
  /** @type {ReturnType<typeof defaultStore.saveReview>|null} */
  let historyEntry = null;
  // 文件之间不具备事务性；保存失败不能把已完成的 AI 调用变成失败。
  if (context.kind === 'overview') {
    try {
      const existing = store.listReviews(folder).find((entry) => entry.id === reviewId);
      if (existing && !context.checklistSaveFailed) {
        snapshot = structuredClone(existing.findings);
        verificationResults = existing.verificationResults;
        checklist = store.listChecklist(folder);
      } else {
        const reconciled = reconcile({ stored: store.listChecklist(folder), markdown: result.markdown,
          files: context.files, captured: context.captured, reviewId });
        if (!reconciled.parsed && result.markdown?.trim()) coverageNotices.push('未能从结果中解析出结构化问题清单，已保留原有问题状态，请查看原文');
        snapshot = structuredClone(reconciled.findings);
        verificationResults = reconciled.verificationResults;
        persistenceWarnings.push(...reconciled.persistenceWarnings);
        try {
          checklist = store.saveChecklist(folder, reconciled.checklist);
          context.checklistSaveFailed = false;
        } catch (error) {
          context.checklistSaveFailed = true;
          throw error;
        }
        if (existing) { snapshot = existing.findings; verificationResults = existing.verificationResults; }
      }
    } catch (error) { persistenceWarnings.push(`问题清单保存失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  try {
    const provenance = context.provenance ? structuredClone(context.provenance) : null;
    if (provenance) {
      const reviewedFiles = (context.files || []).slice(0, context.reviewed ?? context.files.length);
      const { fileDiffFingerprint } = require('./reviewSnapshot');
      provenance.files = provenance.files.map((file) => ({ ...file, reviewed: !file.resource && !file.excluded && reviewedFiles.some((f) =>
        f.path === file.path && fileDiffFingerprint(f) === file.diffFingerprint) }));
    }
    historyEntry = store.saveReview({ folder, id: reviewId, title, kind: historyKind || (context.kind === 'full' ? 'full' : 'review'),
      markdown: result.markdown, stats: result.stats, findings: snapshot, verificationResults, provenance, coverageNotices,
      chatContext: require('./chatStore').capContext({ codeContext: (context.batches || []).flat().join('\n\n'),
        planContext: context.planContext || '', projectRulesText: context.rules?.text || '', initialMarkdown: result.markdown,
        diffFingerprint: provenance?.diffFingerprint || null, source: provenance?.source || null }),
      perModel: context.historyPerModel || (result.perModel || (provenance ? [{ backend: result.stats?.backend || provenance.backends[0]?.backend || 'api',
        model: result.stats?.model || null, markdown: result.markdown, stats: result.stats }] : [])).map((p, i) => ({ ...p, slotId: p.slotId || `reviewer-${i}`, role: p.role || 'reviewer', effort: p.effort || p.stats?.effort || '',
        model: p.model || null, outcome: p.markdown ? 'complete' : 'failed', markdown: p.markdown || null, error: p.error || null, stats: p.stats || null })), noiseLevel });
    if (historyEntry?.persistenceWarnings) persistenceWarnings.push(...historyEntry.persistenceWarnings);
  } catch (error) { persistenceWarnings.push(`评审历史保存失败：${error instanceof Error ? error.message : String(error)}`); }
   const completed = { ...result, reviewId, historyEntry, ...(checklist ? { checklist } : {}), persistenceWarnings, coverageNotices };
  if (historyEntry && !context.checklistSaveFailed) context.persistedResult = completed;
  return completed;
}
module.exports = { completeReview };
