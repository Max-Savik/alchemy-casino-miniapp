// Маркет-скрипт · v1
document.addEventListener('DOMContentLoaded', () => {
  /* ───── плавное появление текста ───── */
  const tl = gsap.timeline({defaults:{ease:'power3.out'}});
  tl.fromTo('#comingSoonHeadline',
           {y:20, opacity:0},
           {y:0, opacity:1, duration:1});
  tl.to('#comingSoonHeadline', {
        repeat:-1, yoyo:true, duration:2, opacity:0.7,
        ease:'sine.inOut'
      }, '+=0.5');

  /* ───── роутинг bottom-nav ───── */
  const nav = {
    navGame:    'index.html#game',
    navMarket:  'market.html',        // остаёмся здесь
    navProfile: 'profile.html',
    navEarn:    'index.html#earn'
  };

  Object.entries(nav).forEach(([btn, url]) => {
    const el = document.getElementById(btn);
    if (!el) return;
    el.addEventListener('click', () => location.href = url);
  });
  /* ── убираем стартовую прозрачность (мягкий fade-in) ── */
  requestAnimationFrame(() => document.body.classList.remove('opacity-0'));
});
