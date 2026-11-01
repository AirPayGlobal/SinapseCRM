/*
 * Sinapse Assist and query widget for namport.com.na.
 * <script src="https://crm.namport.com.na/embed.js" data-port="WB" defer></script>
 */
(function () {
  var s = document.currentScript;
  var origin = new URL(s.src).origin;
  var port = s.getAttribute('data-port') || '';
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Ask Namport');
  btn.textContent = 'Ask Namport';
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#0b2a5b;color:#fff;border:0;border-radius:24px;padding:12px 18px;font:600 15px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer';
  var frame = document.createElement('iframe');
  frame.title = 'Namport Sinapse Assist';
  frame.src = origin + '/widget' + (port ? '?port=' + encodeURIComponent(port) : '');
  frame.style.cssText = 'position:fixed;right:20px;bottom:80px;width:min(380px,calc(100vw - 40px));height:min(600px,calc(100vh - 120px));border:0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);z-index:2147483000;display:none;background:#fff';
  btn.onclick = function () { frame.style.display = frame.style.display === 'none' ? 'block' : 'none'; };
  document.body.appendChild(frame);
  document.body.appendChild(btn);
})();
