(function () {
  window.ThumbnailActions = {
    button(icon, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = icon;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        window.clearTimeout(button.closest('.card')?._clickTimer);
        onClick();
      });
      button.addEventListener('dblclick', (event) => event.stopPropagation());
      return button;
    },
    bindClicks(card, onSingle, onDouble) {
      card.addEventListener('click', (event) => {
        window.clearTimeout(card._clickTimer);
        if (event.detail >= 2) return;
        card._clickTimer = window.setTimeout(() => { if (card.isConnected) onSingle(); }, 500);
      });
      card.addEventListener('dblclick', () => {
        window.clearTimeout(card._clickTimer);
        onDouble();
      });
    },
  };
})();
