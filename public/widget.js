/* ikas Abonelik Modülü – ürün sayfası bileşeni.
 * Mağazaya saveStorefrontJSScript ile yüklenir. Ürün sayfasında "Tek Seferlik / Düzenli Teslimat"
 * seçimini gösterir; düzenli teslimat seçilirse abonelik formunu açar. Kart bilgisi alınmaz. */
(function () {
  if (window.__ikasAbonelik) return;
  window.__ikasAbonelik = true;
  var me = document.currentScript || document.querySelector('script[src*="/widget.js"]');
  var BASE = (window.ABONELIK_API || (me && me.src ? new URL(me.src).origin : location.origin)).replace(/\/$/, '');
  var cfg = null, root = null, lastPath = null, mode = 'one', hiddenEls = [];
  var STORE = window.ABONELIK_STORE || (me && me.src ? new URL(me.src).searchParams.get('store') : '') || '';

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var tl = function (n) { return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(n); };
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  var css = '.abn{border:1px solid #dfe3de;border-radius:10px;padding:12px;margin:12px 0;font-family:inherit;color:#222}' +
    '.abn-opt{display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;cursor:pointer;border:2px solid transparent}' +
    '.abn-opt.on{border-color:#2f6b3a;background:#f3f8f3}.abn-opt input{accent-color:#2f6b3a}.abn-opt b{flex:1}' +
    '.abn-price{white-space:nowrap}.abn-price s{color:#999;font-weight:400;margin-right:6px}.abn-badge{background:#2f6b3a;color:#fff;border-radius:10px;padding:1px 7px;font-size:12px;margin-left:6px}' +
    '.abn-body{padding:6px 10px 2px}.abn-body select,.abn-f input,.abn-f select{width:100%;padding:9px;border:1px solid #ccc;border-radius:8px;margin:4px 0 8px;font:inherit;box-sizing:border-box}' +
    '.abn-body ul{margin:6px 0 10px;padding-left:18px;font-size:13px;color:#444}.abn-btn{width:100%;background:#2f6b3a;color:#fff;border:0;border-radius:8px;padding:12px;font:inherit;font-weight:600;cursor:pointer}' +
    '.abn-btn[disabled]{opacity:.6}.abn-m{position:fixed;inset:0;background:#0007;z-index:99999;display:flex;align-items:center;justify-content:center;padding:12px}' +
    '.abn-f{background:#fff;border-radius:12px;max-width:480px;width:100%;max-height:92vh;overflow:auto;padding:20px;color:#222;font-family:inherit}' +
    '.abn-f h3{margin:0 0 4px}.abn-f label{font-size:13px;color:#555}.abn-g{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}' +
    '.abn-err{color:#b3261e;font-size:14px;min-height:18px}.abn-x{float:right;background:none;border:0;font-size:22px;cursor:pointer}.abn-ok{text-align:center;padding:10px}';

  function api(path, body) {
    path += (path.indexOf('?') === -1 ? '?' : '&') + 'store=' + encodeURIComponent(STORE);
    return fetch(BASE + '/api/public' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Hata'); return j; }); });
  }

  function findAnchor() {
    if (cfg.anchorSelector) { var a = document.querySelector(cfg.anchorSelector); if (a) return a; }
    var btns = document.querySelectorAll('button, a, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim().toLocaleLowerCase('tr');
      if (t === 'sepete ekle' || t.indexOf('sepete ekle') === 0) return btns[i];
    }
    return null;
  }

  function variant() {
    if (cfg.variants.length === 1) return cfg.variants[0];
    var sel = root && root.querySelector('.abn-v');
    return cfg.variants.find(function (v) { return sel && v.id === sel.value; }) || cfg.variants[0];
  }

  function setMode(m) {
    mode = m;
    root.querySelectorAll('.abn-opt').forEach(function (o) { o.classList.toggle('on', o.dataset.m === m); o.querySelector('input').checked = o.dataset.m === m; });
    root.querySelector('.abn-body').style.display = m === 'sub' ? '' : 'none';
    // Düzenli teslimat seçiliyken mağazanın "Sepete Ekle" butonlarını gizle
    hiddenEls.forEach(function (el) { el.style.display = m === 'sub' ? 'none' : ''; });
  }

  function render(anchor) {
    var v = variant(), t = cfg.texts;
    root = document.createElement('div');
    root.className = 'abn';
    root.innerHTML =
      '<label class="abn-opt on" data-m="one"><input type="radio" name="abn-m" checked><b>' + esc(t.oneTime) + '</b><span class="abn-price abn-p1"></span></label>' +
      '<label class="abn-opt" data-m="sub"><input type="radio" name="abn-m"><b>' + esc(t.subscription) + '<span class="abn-badge">%' + cfg.discountPercent + '</span></b><span class="abn-price abn-p2"></span></label>' +
      '<div class="abn-body" style="display:none">' +
      (cfg.variants.length > 1 ? '<label>Seçenek</label><select class="abn-v">' + cfg.variants.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('') + '</select>' : '') +
      '<label>Teslimat sıklığı</label><select class="abn-p"><option value="">Seçiniz</option>' +
      cfg.periods.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>'; }).join('') + '</select>' +
      '<ul>' + t.bullets.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' +
      '<button type="button" class="abn-btn">' + esc(t.button) + '</button></div>';
    var style = document.createElement('style'); style.textContent = css; root.prepend(style);
    anchor.parentNode.insertBefore(root, anchor);

    hiddenEls = [anchor];
    document.querySelectorAll('button, a').forEach(function (b) {
      if (b !== anchor && (b.textContent || '').trim().toLocaleLowerCase('tr') === 'sepete ekle' && !root.contains(b)) hiddenEls.push(b);
    });

    function prices() {
      var x = variant();
      root.querySelector('.abn-p1').textContent = tl(x.price);
      root.querySelector('.abn-p2').innerHTML = '<s>' + esc(tl(x.price)) + '</s>' + esc(tl(x.subscriptionPrice));
    }
    prices();
    root.querySelectorAll('.abn-opt').forEach(function (o) { o.addEventListener('click', function (e) { e.preventDefault(); setMode(o.dataset.m); }); });
    var vs = root.querySelector('.abn-v'); if (vs) vs.addEventListener('change', prices);
    root.querySelector('.abn-btn').addEventListener('click', function () {
      var pid = root.querySelector('.abn-p').value;
      if (!pid) { root.querySelector('.abn-p').focus(); root.querySelector('.abn-p').style.borderColor = '#b3261e'; return; }
      openForm(variant(), cfg.periods.find(function (p) { return p.id === pid; }));
    });
  }

  function openForm(v, period) {
    var now = new Date(), max = new Date(); max.setDate(max.getDate() + (cfg.maxStartDays || 60));
    var m = document.createElement('div'); m.className = 'abn-m';
    var f = function (n, l, type, req) { return '<div><label>' + l + '</label><input name="' + n + '" type="' + (type || 'text') + '"' + (req === false ? '' : ' required') + '></div>'; };
    m.innerHTML = '<form class="abn-f" novalidate><button type="button" class="abn-x" aria-label="Kapat">×</button>' +
      '<h3>' + esc(cfg.texts.subscription) + '</h3><p style="margin:0 0 12px;color:#555;font-size:14px">' + esc(cfg.name) + (cfg.variants.length > 1 ? ' – ' + esc(v.name) : '') +
      ' · ' + esc(period.label) + ' · <b>' + esc(tl(v.subscriptionPrice)) + '</b> / teslimat</p>' +
      '<div class="abn-g"><div><label>Adet</label><input name="quantity" type="number" min="1" max="99" value="1" required></div>' +
      '<div><label>İlk teslimat tarihi</label><input name="startDate" type="date" min="' + ymd(now) + '" max="' + ymd(max) + '" value="' + ymd(now) + '" required></div></div>' +
      '<div class="abn-g">' + f('firstName', 'Ad') + f('lastName', 'Soyad') + '</div>' +
      '<div class="abn-g">' + f('email', 'E-posta', 'email') + f('phone', 'Telefon', 'tel') + '</div>' +
      f('addressLine1', 'Adres') +
      '<div class="abn-g">' + f('city', 'İl') + f('district', 'İlçe') + '</div>' + f('postalCode', 'Posta kodu (opsiyonel)', 'text', false) +
      '<p style="font-size:12px;color:#666">Kart bilgisi alınmaz. Her teslimat gününde siparişiniz otomatik oluşturulur ve e-posta ile bilgilendirilirsiniz. Dilediğiniz zaman erteleyebilir veya iptal edebilirsiniz.</p>' +
      '<div class="abn-err"></div><button class="abn-btn" type="submit">Aboneliği Onayla</button></form>';
    var style = document.createElement('style'); style.textContent = css; m.prepend(style);
    document.body.appendChild(m);
    var close = function () { m.remove(); };
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    m.querySelector('.abn-x').addEventListener('click', close);
    var form = m.querySelector('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var d = Object.fromEntries(new FormData(form)), err = m.querySelector('.abn-err');
      var missing = Array.prototype.find.call(form.querySelectorAll('[required]'), function (i) { return !i.value.trim(); });
      if (missing) { err.textContent = 'Lütfen tüm zorunlu alanları doldurun.'; missing.focus(); return; }
      var btn = form.querySelector('button[type=submit]'); btn.disabled = true; err.textContent = '';
      api('/subscribe', {
        productId: cfg.productId, variantId: v.id, periodId: period.id, quantity: d.quantity, startDate: d.startDate,
        customer: { firstName: d.firstName, lastName: d.lastName, email: d.email, phone: d.phone },
        address: { addressLine1: d.addressLine1, city: d.city, district: d.district, postalCode: d.postalCode },
      }).then(function (r) {
        form.innerHTML = '<div class="abn-ok"><h3>Aboneliğiniz oluşturuldu 🎉</h3><p>İlk teslimat: <b>' +
          esc(new Date(r.nextDate + 'T00:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })) +
          '</b></p><p style="font-size:14px;color:#555">Detaylar ve yönetim bağlantısı e-posta adresinize gönderildi.</p>' +
          '<button type="button" class="abn-btn">Tamam</button></div>';
        form.querySelector('.abn-btn').addEventListener('click', close);
      }).catch(function (x) { err.textContent = x.message; btn.disabled = false; });
    });
  }

  function cleanup() { if (root) root.remove(); root = null; hiddenEls.forEach(function (el) { el.style.display = ''; }); hiddenEls = []; mode = 'one'; }

  function check() {
    var p = location.pathname;
    if (p !== lastPath) {
      lastPath = p; cleanup(); cfg = null;
      var slug = window.ABONELIK_SLUG || decodeURIComponent(p.replace(/^\/+|\/+$/g, ''));
      if (!slug || slug.indexOf('/') !== -1 && slug.indexOf('urun/') !== 0) return;
      api('/config?slug=' + encodeURIComponent(slug.replace(/^urun\//, ''))).then(function (c) { if (p === lastPath && c.enabled) cfg = c; }).catch(function () {});
      return;
    }
    if (cfg && (!root || !document.body.contains(root))) {
      var a = findAnchor();
      if (a) { if (root) cleanup(); render(a); }
    }
  }
  // ikas mağazaları SPA (Next.js) olduğundan sayfa değişimleri periyodik kontrol edilir.
  setInterval(check, 700);
  check();
})();
