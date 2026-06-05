/* ═══════════════════════════════════════════════
   ProGear — Shared App JS
   Reads all data from config.json
═══════════════════════════════════════════════ */

const PG = {
  config: null,

  async loadConfig() {
    const r = await fetch('/config.json?v=' + Date.now());
    this.config = await r.json();
    return this.config;
  },

  // ── Stars helper ──
  stars(rating) {
    const full = Math.floor(rating);
    const half = rating % 1 >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    return '★'.repeat(full) + (half ? '☆' : '') + '☆'.repeat(empty);
  },

  starsHTML(rating) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += `<span class="${i <= Math.round(rating) ? 'star-filled' : 'star-empty'}">★</span>`;
    }
    return `<span class="stars-display">${html}</span>`;
  },

  // ── Price format ──
  price(n) {
    return 'Rs. ' + Number(n).toLocaleString('en-PK');
  },

  // ── Affiliate source label ──
  sourceLabel(src) {
    const map = { daraz: 'Buy on Daraz', telemart: 'Buy on Telemart' };
    return map[src] || 'Buy Now';
  },

  // ── Product card HTML ──
  productCard(p) {
    const cat = this.config.categories.find(c => c.id === p.category);
    const badge = p.badge ? `<div class="product-badge">${p.badge}</div>` : '';
    const tags = (p.tags || []).slice(0, 3).map(t => `<span class="product-tag">${t}</span>`).join('');
    return `
      <div class="product-card reveal">
        <div class="product-img-wrap">
          <img src="${p.image}" alt="${p.name}" loading="lazy">
          ${badge}
        </div>
        <div class="product-body">
          <div class="product-cat">${cat ? cat.icon + ' ' + cat.name : ''}</div>
          <div class="product-name">${p.name}</div>
          <div class="product-tags">${tags}</div>
          <div class="product-rating">
            ${this.starsHTML(p.rating)}
            <span class="rating-count">(${Number(p.reviews).toLocaleString()})</span>
          </div>
          <div class="product-footer">
            <div class="product-price">${this.price(p.price)} <span>PKR</span></div>
            <a href="/product.html?id=${p.id}" class="product-btn">View →</a>
          </div>
        </div>
      </div>`;
  },

  // ── Nav HTML ──
  navHTML() {
    const cfg = this.config.site;
    return `
      <div class="announce-bar">${cfg.announcement}</div>
      <nav class="nav">
        <a href="/" class="nav-logo">Pro<span>Gear</span></a>
        <ul class="nav-links" id="nav-links">
          <li><a href="/">Home</a></li>
          <li><a href="/category.html?slug=keyboards">Keyboards</a></li>
          <li><a href="/category.html?slug=mice">Mice</a></li>
          <li><a href="/category.html?slug=headsets">Headsets</a></li>
          <li><a href="/category.html?slug=controllers">Controllers</a></li>
          <li><a href="/blog.html">Blog</a></li>
        </ul>
        <div class="nav-right">
          <div class="nav-social">
            ${cfg.socials.tiktok ? `<a href="${cfg.socials.tiktok}" target="_blank" title="TikTok">🎵</a>` : ''}
            ${cfg.socials.instagram ? `<a href="${cfg.socials.instagram}" target="_blank" title="Instagram">📸</a>` : ''}
          </div>
          <button class="nav-search-btn" onclick="PG.openSearch()">🔍 Search</button>
          <button class="menu-toggle" onclick="PG.openMobileNav()">☰</button>
        </div>
      </nav>
      <div class="marquee-wrap">
        <div class="marquee-track" id="marquee-track"></div>
      </div>`;
  },

  // ── Footer HTML ──
  footerHTML() {
    const cfg = this.config.site;
    const cats = this.config.categories;
    const catLinks = cats.map(c => `<a href="/category.html?slug=${c.slug}">${c.icon} ${c.name}</a>`).join('');
    return `
      <footer class="footer">
        <div class="footer-inner">
          <div class="footer-grid">
            <div class="footer-brand">
              <div class="logo">Pro<span>Gear</span></div>
              <p class="footer-desc">${cfg.description}</p>
              <div class="footer-socials">
                ${cfg.socials.tiktok ? `<a href="${cfg.socials.tiktok}" target="_blank" class="footer-social-btn" title="TikTok">🎵</a>` : ''}
                ${cfg.socials.instagram ? `<a href="${cfg.socials.instagram}" target="_blank" class="footer-social-btn" title="Instagram">📸</a>` : ''}
              </div>
            </div>
            <div class="footer-col">
              <h4>Categories</h4>
              ${catLinks}
            </div>
            <div class="footer-col">
              <h4>Quick Links</h4>
              <a href="/">Home</a>
              <a href="/blog.html">Gaming Blog</a>
              <a href="/about.html">About</a>
              <a href="/contact.html">Contact</a>
            </div>
            <div class="footer-col">
              <h4>Legal</h4>
              <a href="/affiliate-disclosure.html">Affiliate Disclosure</a>
              <a href="/privacy.html">Privacy Policy</a>
              <a href="/terms.html">Terms of Service</a>
            </div>
          </div>
          <div class="footer-bottom">
            <span>© 2026 ProGear. All rights reserved.</span>
            <span class="affiliate-note">ProGear participates in affiliate programs. We may earn commissions from purchases made through our links, at no extra cost to you.</span>
          </div>
        </div>
      </footer>`;
  },

  // ── Search overlay ──
  searchOverlayHTML() {
    return `
      <div class="search-overlay" id="search-overlay">
        <div class="search-box">
          <div class="search-input-wrap">
            <span style="font-size:20px;color:var(--text3)">🔍</span>
            <input type="text" id="search-input" placeholder="Search gaming gear..." autocomplete="off" oninput="PG.onSearch(this.value)">
            <button class="search-close" onclick="PG.closeSearch()">✕</button>
          </div>
          <div class="search-results" id="search-results">
            <div class="search-empty">Start typing to search products...</div>
          </div>
        </div>
      </div>`;
  },

  // ── Mobile nav ──
  mobileNavHTML() {
    const cats = this.config.categories;
    const catLinks = cats.map(c => `<li><a href="/category.html?slug=${c.slug}" onclick="PG.closeMobileNav()">${c.icon} ${c.name}</a></li>`).join('');
    return `
      <div class="mobile-nav" id="mobile-nav">
        <div class="mobile-nav-header">
          <span class="nav-logo">Pro<span style="color:var(--neon)">Gear</span></span>
          <button class="mobile-nav-close" onclick="PG.closeMobileNav()">✕</button>
        </div>
        <ul class="mobile-nav-links">
          <li><a href="/" onclick="PG.closeMobileNav()">Home</a></li>
          ${catLinks}
          <li><a href="/blog.html" onclick="PG.closeMobileNav()">Blog</a></li>
        </ul>
      </div>`;
  },

  openSearch() {
    document.getElementById('search-overlay').classList.add('open');
    setTimeout(() => document.getElementById('search-input').focus(), 100);
  },
  closeSearch() {
    document.getElementById('search-overlay').classList.remove('open');
  },
  openMobileNav() {
    document.getElementById('mobile-nav').classList.add('open');
  },
  closeMobileNav() {
    document.getElementById('mobile-nav').classList.remove('open');
  },

  onSearch(q) {
    const el = document.getElementById('search-results');
    if (!q.trim()) { el.innerHTML = '<div class="search-empty">Start typing to search products...</div>'; return; }
    const results = this.config.products.filter(p =>
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      (p.description && p.description.toLowerCase().includes(q.toLowerCase())) ||
      (p.tags || []).some(t => t.toLowerCase().includes(q.toLowerCase()))
    ).slice(0, 8);
    if (!results.length) { el.innerHTML = '<div class="search-empty">No products found for "' + q + '"</div>'; return; }
    el.innerHTML = results.map(p => `
      <a href="/product.html?id=${p.id}" class="search-result-item" onclick="PG.closeSearch()">
        <img class="search-result-img" src="${p.image}" alt="${p.name}">
        <div>
          <div class="search-result-name">${p.name}</div>
          <div class="search-result-cat">${p.category}</div>
        </div>
        <div style="margin-left:auto;font-family:var(--font-display);font-weight:800;color:var(--neon)">${this.price(p.price)}</div>
      </a>`).join('');
  },

  // ── Marquee ──
  buildMarquee() {
    const items = this.config.marquee || [];
    const track = document.getElementById('marquee-track');
    if (!track) return;
    const doubled = [...items, ...items];
    track.innerHTML = doubled.map(item => `<div class="marquee-item"><span>◆</span>${item}</div>`).join('');
  },

  // ── Reveal on scroll ──
  initReveal() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in-view'); } });
    }, { threshold: 0.1 });
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
  },

  // ── Active nav link ──
  setActiveNav() {
    const path = window.location.pathname;
    document.querySelectorAll('.nav-links a').forEach(a => {
      if (a.getAttribute('href') === path || (path === '/' && a.getAttribute('href') === '/')) {
        a.classList.add('active');
      }
    });
  },

  // ── Toast ──
  toast(msg, type = 'success') {
    let t = document.getElementById('pg-toast');
    if (!t) { t = document.createElement('div'); t.id = 'pg-toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = `toast ${type}`;
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => t.classList.remove('show'), 3000);
  },

  // ── Inject shared chrome ──
  injectChrome() {
    const header = document.getElementById('pg-header');
    const footer = document.getElementById('pg-footer');
    if (header) header.innerHTML = this.navHTML() + this.searchOverlayHTML() + this.mobileNavHTML();
    if (footer) footer.innerHTML = this.footerHTML();
    this.buildMarquee();
    // Close search on overlay click
    document.getElementById('search-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'search-overlay') this.closeSearch();
    });
    // Close mobile nav on overlay area
    document.getElementById('mobile-nav')?.addEventListener('click', (e) => {
      if (e.target.id === 'mobile-nav') this.closeMobileNav();
    });
    // ESC key
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { this.closeSearch(); this.closeMobileNav(); } });
  },

  async init() {
    await this.loadConfig();
    this.injectChrome();
    this.setActiveNav();
    // Delay reveal init slightly for DOM
    setTimeout(() => this.initReveal(), 100);
  }
};
