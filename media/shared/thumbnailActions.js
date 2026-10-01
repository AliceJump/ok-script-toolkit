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
        const card = button.closest('.card');
        window.clearTimeout(card?._clickTimer);
        if (card) card._clickTimer = undefined;
        onClick();
      });
      button.addEventListener('dblclick', (event) => event.stopPropagation());
      return button;
    },
    bindClicks(card, onSingle, onDouble) {
      // Use the same 500ms gesture window for committing and recognizing clicks.
      // A late native dblclick cannot copy after an insertion has already committed.
      card.addEventListener('click', (event) => {
        if (event.button !== 0 || event.detail > 2) return;
        const pending = card._clickTimer !== undefined;
        window.clearTimeout(card._clickTimer);
        card._clickTimer = undefined;
        if (pending) {
          onDouble();
          return;
        }
        card._clickTimer = window.setTimeout(() => {
          card._clickTimer = undefined;
          if (card.isConnected) onSingle();
        }, 500);
      });
    },
  };
})();
