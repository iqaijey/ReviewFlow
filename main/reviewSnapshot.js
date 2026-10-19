const { createHash, randomUUID } = require('crypto');

/** @typedef {'uncommitted'|'branch'|'ref'|'commits'|'staged'|'unstaged'|'untracked'} ReviewMode */
/** @typedef {{mode:ReviewMode|null, requestedBase:string|null, branch:string|null, headSha:string|null, baseSha:string|null, commits:Array<{sha:string,parentShas:string[]}>, semantics:'head-to-worktree'|'base-to-worktree'|'concatenated-show'|'commit-range'|'head-to-index'|'index-to-worktree'|'untracked-only'|null,nonContiguous?:boolean,revisionRange?:{fromSha:string,toSha:string,operator:string}}} ReviewSource */
/** @typedef {{path:string,oldPath?:string|null,status:string,resource?:boolean,excluded?:boolean,excludedBy?:string,truncated?:boolean,classes?:Array<{name:string,kind:string,startLine:number,endLine:number,changed:boolean}>,hunks:Array<{header:string,oldStart?:number,newStart?:number,oldLines?:number,newLines?:number,lines:Array<{type:string,oldLine?:number|null,newLine?:number|null,content:string}>}>}} SnapshotInput */
/** @typedef {{path:string,oldPath:string|null,status:string,resource:boolean,excluded:boolean,diffFingerprint:string,reviewed:boolean,truncated:boolean}} SnapshotFile */
/** @typedef {{snapshotId:string,capturedAt:number,source:ReviewSource,diffFingerprint:string,files:SnapshotFile[]}} ReviewSnapshot */
/** @typedef {{slotId:string,role:'reviewer'|'synthesizer',backend:string,requestedModel:string|null,resolvedModel:string|null,modelSource:'settings'|'cli-config'|'backend-default',effort:string}} ReviewBackend */
/** @typedef {Omit<ReviewSnapshot,'snapshotId'> & {plan:{id:string,title:string,contextHash:string}|null,preset:{id:string,name:string}|null,projectRules:{fileHash:string|null,injectedHash:string,files:string[]},appVersion:string,promptVersion:string,promptInputsHash:string,noiseLevel:'quiet'|'balanced'|'detailed',backends:ReviewBackend[]}} Provenance */
/** @param {string|Buffer} value */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** @param {SnapshotInput} file */
function fileDiffFingerprint(file) {
  return hash(JSON.stringify([file.path, file.oldPath || null, file.status,
    (file.hunks || []).map((h) => [h.header, h.lines.map((l) => [l.type, l.oldLine ?? null, l.newLine ?? null, l.content])])]));
}

/** @type {Map<string,{folder:string,snapshot:ReviewSnapshot,refs:Set<string>,diff:SnapshotInput[]}>} */
const registry = new Map();
function pruneSnapshots() {
  const old = [...registry.keys()].slice(0, -20);
  for (const id of old) {
    const entry = registry.get(id);
    if (entry) for (const runId of entry.refs) if (!require('./ai/state').lanes.has(runId)) entry.refs.delete(runId);
    if (!entry?.refs.size) registry.delete(id);
  }
}
/** @param {SnapshotInput[]} files @param {ReviewSource|null} source @returns {ReviewSnapshot} */
function buildSnapshot(files, source) {
  const capturedSource = source ? structuredClone(source) : { mode: null, requestedBase: null, branch: null, headSha: null, baseSha: null, commits: [], semantics: null };
  if (capturedSource.semantics === 'commit-range' && capturedSource.commits.length) {
    const selected = new Set(capturedSource.commits.map((c) => c.sha));
    const oldest = capturedSource.commits.find((c) => !selected.has(c.parentShas[0]));
    if (oldest) capturedSource.baseSha = oldest.parentShas[0] || capturedSource.baseSha || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  }
  const entries = files.map((f) => ({ path: f.path, oldPath: f.oldPath || null, status: f.status,
    resource: f.resource === true, excluded: f.excluded === true, diffFingerprint: fileDiffFingerprint(f), reviewed: false, truncated: f.truncated === true }));
  return { snapshotId: randomUUID(), capturedAt: Date.now(),
    source: capturedSource,
    diffFingerprint: hash(JSON.stringify(['diff-v2', source?.commits.map((c) => c.sha) || [], entries.map((f) => f.diffFingerprint)])), files: entries };
}
/** @param {string} folder @param {SnapshotInput[]} files @param {ReviewSource|null} source */
function captureSnapshot(folder, files, source) {
  const snapshot = buildSnapshot(files, source);
  registry.set(snapshot.snapshotId, { folder, snapshot, refs: new Set(), diff: files.map((f) => ({ path: f.path, oldPath: f.oldPath,
    status: f.status, resource: f.resource, excluded: f.excluded, excludedBy: f.excludedBy, truncated: f.truncated, classes: structuredClone(f.classes),
    hunks: f.hunks.map((h) => ({ header: h.header, oldStart: h.oldStart, newStart: h.newStart, oldLines: h.oldLines, newLines: h.newLines,
      lines: h.lines.map((l) => ({ type: l.type, oldLine: l.oldLine, newLine: l.newLine, content: l.content })) })) })) });
  pruneSnapshots();
  return structuredClone(snapshot);
}
function getSnapshot(id, folder) {
  const entry = registry.get(id);
  return entry && entry.folder === folder ? structuredClone(entry.snapshot) : null;
}
function getSnapshotFiles(id, folder) {
  const entry = registry.get(id);
  return entry && entry.folder === folder ? structuredClone(entry.diff) : null;
}
function getLatestSnapshot(folder) {
  const entry = [...registry.values()].reverse().find((item) => item.folder === folder);
  return entry ? structuredClone(entry.snapshot) : null;
}
function retainSnapshot(id, runId) { registry.get(id)?.refs.add(runId); }
function releaseSnapshot(id, runId) { registry.get(id)?.refs.delete(runId); pruneSnapshots(); }
function releaseRunSnapshots(runId) { for (const entry of registry.values()) entry.refs.delete(runId); pruneSnapshots(); }
module.exports = { hash, fileDiffFingerprint, buildSnapshot, captureSnapshot, getSnapshot, getSnapshotFiles, getLatestSnapshot, retainSnapshot, releaseSnapshot, releaseRunSnapshots };
