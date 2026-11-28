import type { Answer } from '@gof/core';
import { useEffect, useRef } from 'react';

export type KeyPhase = 'question' | 'reveal' | 'other';
export type KeyAction = Answer | 'next' | null;

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { target: EventTarget | null };

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

/**
 * Keyboard map:
 *  - question phase: G = GTA, F = Florida
 *  - reveal phase: Enter, N or → = next
 * Ignored while busy, with a modifier held, or while typing in a field. Enter on a link, button or
 * summary is left to the browser so that element acts normally (a focused Next button still advances).
 */
export function keyAction(e: KeyLike, phase: KeyPhase, busy: boolean): KeyAction {
  if (busy || phase === 'other') return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const target = e.target instanceof Element ? e.target : null;
  if (isTyping(target)) return null;
  const key = e.key.toLowerCase();
  if (phase === 'question') return key === 'g' ? 'gta' : key === 'f' ? 'florida' : null;
  if (key === 'enter') return target?.closest('a, button, summary') ? null : 'next';
  return key === 'n' || key === 'arrowright' ? 'next' : null;
}

export function useDriveKeys(phase: KeyPhase, busy: boolean, onChoose: (choice: Answer) => void, onNext: () => void): void {
  const latest = useRef({ phase, busy, onChoose, onNext });
  latest.current = { phase, busy, onChoose, onNext };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const { phase, busy, onChoose, onNext } = latest.current;
      const action = keyAction(e, phase, busy);
      if (!action) return;
      e.preventDefault();
      if (action === 'next') onNext();
      else onChoose(action);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
