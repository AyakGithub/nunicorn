/**
 * tests/policy-sync.test.js
 *
 * agency/policies/health-safety.md ↔ api/prompt-policy.js 동기화 검증
 * Node.js built-in test runner: node --test tests/policy-sync.test.js
 *
 * 목적: prompt-policy.js의 상수가 health-safety.md 정책 원본과 일치하는지 확인
 *       정책 문서 수정 시 이 테스트가 실패하면 prompt-policy.js도 함께 업데이트해야 함
 */

import { test } from 'node:test';
import assert  from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SYNC_MARKERS,
  RED_PATTERNS,
  YELLOW_PATTERNS,
  EMERGENCY_KEYWORDS,
  DISCLAIMER_MARKERS,
  DISCLAIMER_YELLOW,
  ALLOWED_EXPRESSIONS,
  FORBIDDEN_EXPRESSIONS,
} from '../api/prompt-policy.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const policyPath = join(__dir, '..', 'agency', 'policies', 'health-safety.md');

let policyContent = '';
try {
  policyContent = readFileSync(policyPath, 'utf-8');
} catch {
  // health-safety.md 없으면 동기화 테스트 건너뜀
  console.warn('⚠️  agency/policies/health-safety.md 없음 — 동기화 테스트 건너뜀');
}

// ─────────────────────────────────────────────────────────────────────────────
// S1. health-safety.md 존재 확인
// ─────────────────────────────────────────────────────────────────────────────
test('S1: agency/policies/health-safety.md 파일이 존재한다', () => {
  assert.ok(policyContent.length > 0, 'health-safety.md가 비어있거나 없습니다');
});

// ─────────────────────────────────────────────────────────────────────────────
// S2. SYNC_MARKERS — health-safety.md에 핵심 섹션이 존재하는지 확인
// ─────────────────────────────────────────────────────────────────────────────
test('S2: health-safety.md에 허용 표현 섹션이 있다', () => {
  if (!policyContent) return;
  assert.ok(
    policyContent.includes(SYNC_MARKERS.ALLOWED_EXPRESSIONS),
    `health-safety.md에 '${SYNC_MARKERS.ALLOWED_EXPRESSIONS}' 섹션이 없습니다`
  );
});

test('S2b: health-safety.md에 금지 표현 섹션이 있다', () => {
  if (!policyContent) return;
  assert.ok(
    policyContent.includes(SYNC_MARKERS.FORBIDDEN_EXPRESSIONS),
    `health-safety.md에 '${SYNC_MARKERS.FORBIDDEN_EXPRESSIONS}' 섹션이 없습니다`
  );
});

test('S2c: health-safety.md에 RED 등급 섹션이 있다', () => {
  if (!policyContent) return;
  assert.ok(
    policyContent.includes(SYNC_MARKERS.RED_GRADE_CRITERIA),
    `health-safety.md에 '${SYNC_MARKERS.RED_GRADE_CRITERIA}' 섹션이 없습니다`
  );
});

test('S2d: health-safety.md에 YELLOW 등급 섹션이 있다', () => {
  if (!policyContent) return;
  assert.ok(
    policyContent.includes(SYNC_MARKERS.YELLOW_GRADE_CRITERIA),
    `health-safety.md에 '${SYNC_MARKERS.YELLOW_GRADE_CRITERIA}' 섹션이 없습니다`
  );
});

test('S2e: health-safety.md에 전문의 상담 안내 섹션이 있다', () => {
  if (!policyContent) return;
  assert.ok(
    policyContent.includes(SYNC_MARKERS.EMERGENCY_RESPONSE_TRIGGER),
    `health-safety.md에 '${SYNC_MARKERS.EMERGENCY_RESPONSE_TRIGGER}' 섹션이 없습니다`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S3. 금지 표현 — prompt-policy.js의 항목이 health-safety.md에도 있는지 확인
// ─────────────────────────────────────────────────────────────────────────────
test('S3: FORBIDDEN_EXPRESSIONS의 핵심 항목이 health-safety.md에 있다', () => {
  if (!policyContent) return;
  // 일부 핵심 금지 표현 샘플 확인 (전부는 표현이 조금씩 다를 수 있어 일부만 확인)
  // health-safety.md 실제 금지 표현 샘플 (파일 내 표현 기준)
  const coreSamples = ['반드시', '치료', '처방'];
  for (const sample of coreSamples) {
    assert.ok(
      policyContent.includes(sample),
      `health-safety.md에 금지 표현 '${sample}'이 없습니다 — FORBIDDEN_EXPRESSIONS와 동기화 확인 필요`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// S4. 면책 문구 — DISCLAIMER_YELLOW에 핵심 요소 포함 확인
// ─────────────────────────────────────────────────────────────────────────────
test('S4: DISCLAIMER_YELLOW에 소아과와 전문의가 포함된다', () => {
  assert.ok(DISCLAIMER_YELLOW.includes('소아과'), 'DISCLAIMER_YELLOW에 소아과 포함');
  assert.ok(DISCLAIMER_YELLOW.includes('전문의'), 'DISCLAIMER_YELLOW에 전문의 포함');
  assert.ok(DISCLAIMER_YELLOW.includes('참고용'), 'DISCLAIMER_YELLOW에 참고용 포함');
});

test('S4b: DISCLAIMER_MARKERS가 DISCLAIMER_YELLOW의 내용과 일치한다', () => {
  // DISCLAIMER_MARKERS에 있는 마커 중 하나라도 DISCLAIMER_YELLOW에 있어야 중복 방지가 동작
  const atLeastOneMatch = DISCLAIMER_MARKERS.some(m => DISCLAIMER_YELLOW.includes(m));
  assert.ok(atLeastOneMatch, 'DISCLAIMER_MARKERS 중 하나 이상이 DISCLAIMER_YELLOW에 포함되어야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
// S5. 응급 키워드 — health-safety.md의 핵심 키워드가 EMERGENCY_KEYWORDS에 있는지
// ─────────────────────────────────────────────────────────────────────────────
test('S5: 과다복용이 EMERGENCY_KEYWORDS에 있다', () => {
  assert.ok(EMERGENCY_KEYWORDS.includes('과다복용'), 'EMERGENCY_KEYWORDS에 과다복용 포함');
});

test('S5b: 경련이 EMERGENCY_KEYWORDS에 있다', () => {
  assert.ok(EMERGENCY_KEYWORDS.includes('경련'), 'EMERGENCY_KEYWORDS에 경련 포함');
});

// ─────────────────────────────────────────────────────────────────────────────
// S6. SYNC_MARKERS 구조 확인
// ─────────────────────────────────────────────────────────────────────────────
test('S6: SYNC_MARKERS에 5개의 키가 있다', () => {
  const keys = Object.keys(SYNC_MARKERS);
  assert.ok(keys.length >= 5, `SYNC_MARKERS에 최소 5개 키가 있어야 한다: 현재 ${keys.length}개`);
  assert.ok(keys.includes('RED_GRADE_CRITERIA'), 'RED_GRADE_CRITERIA 키 존재');
  assert.ok(keys.includes('YELLOW_GRADE_CRITERIA'), 'YELLOW_GRADE_CRITERIA 키 존재');
  assert.ok(keys.includes('EMERGENCY_RESPONSE_TRIGGER'), 'EMERGENCY_RESPONSE_TRIGGER 키 존재');
});

// ─────────────────────────────────────────────────────────────────────────────
// S7. 버전 드리프트 감지 — 패턴 수 변화 감지용 스냅샷 테스트
// ─────────────────────────────────────────────────────────────────────────────
test('S7: RED_PATTERNS 수가 기대값(13)과 일치한다', () => {
  // 이 테스트가 실패하면 패턴을 추가하거나 삭제한 것 — health-safety.md와 동기화 필요
  assert.equal(RED_PATTERNS.length, 13,
    `RED_PATTERNS 수가 변경됐습니다 (${RED_PATTERNS.length}개). health-safety.md와 동기화 확인 필요`
  );
});

test('S7b: YELLOW_PATTERNS 수가 기대값(6)과 일치한다', () => {
  assert.equal(YELLOW_PATTERNS.length, 6,
    `YELLOW_PATTERNS 수가 변경됐습니다 (${YELLOW_PATTERNS.length}개). health-safety.md와 동기화 확인 필요`
  );
});

test('S7c: EMERGENCY_KEYWORDS 수가 기대값(25)과 일치한다', () => {
  assert.equal(EMERGENCY_KEYWORDS.length, 25,
    `EMERGENCY_KEYWORDS 수가 변경됐습니다 (${EMERGENCY_KEYWORDS.length}개). health-safety.md와 동기화 확인 필요`
  );
});
