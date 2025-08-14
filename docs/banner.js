(function(){
  const WebApp = window.Telegram && Telegram.WebApp;
  const root = document.documentElement;
  const area = document.getElementById('tgTopArea');
  const banner = document.getElementById('topPromoBanner');

  function setTopbarHeight(){
    let h = 0;
    if (WebApp){
      const ios = WebApp.platform === 'ios';
      if (ios){
        root.classList.add('tg-ios');
        root.style.setProperty('--tg-top-extra','40px');
        root.style.setProperty('--tg-banner-shift','24px');
      }
      h = ios ? 50 : 56;
      area.style.display = 'block';
    } else {
      area.style.display = 'none';
    }
    root.style.setProperty('--tg-topbar', h + 'px');
  }

  setTopbarHeight();
  WebApp?.onEvent('viewportChanged', setTopbarHeight);

  banner?.addEventListener('click', (e)=>{
    e.preventDefault();
    const url = banner.getAttribute('href');
    if (WebApp?.openTelegramLink && /^https?:\/\/t\.me\//i.test(url)) {
      WebApp.openTelegramLink(url);
    } else if (WebApp?.openLink) {
      WebApp.openLink(url);
    } else {
      window.open(url, '_blank');
    }
  });
})();
