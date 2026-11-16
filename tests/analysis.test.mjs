import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProposal } from '../packages/fusion/host/analysis.mjs';

test('model output admits only content and cannot inject permissions or files', () => {
  const proposal = { persona: 'combined role', memory: 'facts [a]', notes: [], conflicts: [] };
  assert.deepEqual(validateProposal(JSON.stringify(proposal)), proposal);
  assert.throws(() => validateProposal({ ...proposal, grants: ['/'] }), /未允许/);
  assert.throws(() => validateProposal({ ...proposal, files: [{ path: '../AGENTS.md' }] }), /未允许/);
  assert.throws(() => validateProposal({ ...proposal, memory: 12 }), /无效/);
  assert.throws(() => validateProposal({ ...proposal, conflicts: [{ code: 'run' }] }), /无效/);
});
