// GSAP 進入點：註冊 useGSAP 並提供 reduced-motion 判斷。
// 原則（spec §4）：事件性動作用 GSAP、微互動用 CSS transition。
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

export { gsap, useGSAP };

/** 使用者要求減少動態時回 false——所有 GSAP 動效前都要判斷。 */
export const motionOK = (): boolean =>
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
