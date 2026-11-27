(() => {
  const loaded = document.querySelector('meta[name="ltcook-web-build"]')?.content;
  if (!loaded) return;

  let checking = false;
  let notice;
  let description;

  function showUpdate(current) {
    if (!notice) {
      notice = document.createElement('aside');
      notice.setAttribute('aria-label', 'LTCook update');
      notice.style.cssText =
        'position:fixed;bottom:16px;right:16px;z-index:10000;max-width:calc(100vw - 32px);' +
        'box-sizing:border-box;padding:12px;background:#202524;color:#fff;' +
        'border:1px solid #858987;border-radius:8px;font:14px system-ui';
      description = document.createElement('p');
      description.setAttribute('role', 'status');
      description.style.margin = '0 0 8px';
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Reload Paseo';
      reload.addEventListener('click', () => window.location.reload());
      notice.append(description, reload);
      document.body.append(notice);
    }
    description.textContent = `LTCook has updated. This tab uses build ${loaded.slice(0, 12)}. Build ${current.slice(0, 12)} is available.`;
  }

  async function check() {
    if (checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const response = await fetch('/ltcook-build.json', {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const { build } = await response.json();
      if (typeof build !== 'string' || !/^[a-f0-9]{64}$/.test(build)) return;
      if (build !== loaded) showUpdate(build);
      else if (notice) {
        notice.remove();
        notice = undefined;
        description = undefined;
      }
    } catch {
      // > Keep the loaded identity while the host restarts or is unreachable.
    } finally {
      checking = false;
    }
  }

  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  window.setInterval(check, 30_000);
  void check();
})();
