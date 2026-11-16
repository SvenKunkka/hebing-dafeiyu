import * as React from 'react';
import { FusionPage, type Call } from './page';
import css from './styles.css';

export const name = 'forge-fusion';
export const inject = ['slots', 'layout', 'connection'];
export const PANEL_ID = 'forge-fusion';

export function apply(ctx: any) {
  const call: Call = async (method, payload = {}, signal) => {
    const rpc = ctx.connection?.rpc;
    if (!rpc) throw new Error('尚未连接机器人服务，请等待连接恢复后重试。');
    const args = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
    const response = await rpc.call('/api', `forgeFusion/${method}`, { args }, signal);
    if (response?.ok === false) {
      const message = response.error?.message ?? response.error?.reason ?? '操作未完成，请重试。';
      throw new Error(message);
    }
    return response?.ok === true ? response.value : response;
  };

  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.forgeFusion = 'true';
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });

  const page = () => <FusionPage call={call} />;
  // DSH's native sidebar owns the row label and click target; this slot is
  // only its glyph, including when the sidebar is collapsed.
  const entry = () => <FusionIcon />;

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => '机器人融合',
  }, entry));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, page));

  // Bot mode replaces the native sidebar. Its panel registry is a separate,
  // supported extension point and keeps the existing chat implementation intact.
  ctx.inject(['dockPanels'], (child: any) => {
    child.effect(() => child.dockPanels.register({
      id: PANEL_ID,
      title: '机器人融合',
      icon: 'sparkles',
      scope: 'global',
      order: -90,
      defaultPosition: { zone: 'center' },
      component: page,
    }));
  });
}

function FusionIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="9" height="14" rx="2" transform="rotate(-10 3 4)" /><rect x="11" y="5" width="9" height="14" rx="2" transform="rotate(10 11 5)" /><path d="m12 10 .7 2.3L15 13l-2.3.7L12 16l-.7-2.3L9 13l2.3-.7Z" /></svg>;
}
