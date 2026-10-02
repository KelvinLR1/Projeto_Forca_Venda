// Keep the native select as the source of truth for forms and existing listeners.
export function enhanceSelects(root = document) {
  let openControl = null;
  let nextId = 0;

  function close({ restoreFocus = false } = {}) {
    if (!openControl) return;
    const { trigger, menu, wrapper } = openControl;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    wrapper.classList.remove('is-open');
    openControl = null;
    if (restoreFocus) trigger.focus();
  }

  for (const select of root.querySelectorAll('select:not([multiple])')) {
    if (select.closest('.custom-select')) continue;

    const wrapper = document.createElement('span');
    wrapper.className = `custom-select${select.classList.contains('select-small') ? ' custom-select-compact' : ''}`;
    select.before(wrapper);
    wrapper.append(select);
    select.classList.add('custom-select-native');
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.id = `custom-select-menu-${++nextId}`;
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    wrapper.append(trigger, menu);

    const label = select.closest('label');
    const labelText = select.getAttribute('aria-label') ||
      [...(label?.childNodes || [])].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).filter(Boolean).join(' ');
    if (labelText) trigger.setAttribute('aria-label', labelText);

    function refresh() {
      const selected = select.selectedOptions[0];
      const display = selected?.textContent.trim() || select.getAttribute('placeholder') || 'Selecione uma opção';
      trigger.innerHTML = '';
      const value = document.createElement('span');
      value.className = 'custom-select-value';
      value.textContent = display;
      trigger.append(value);
      trigger.disabled = select.disabled || !select.options.length;
      menu.replaceChildren();
      [...select.options].forEach((option, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'custom-select-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
        item.tabIndex = -1;
        item.disabled = option.disabled;
        item.dataset.index = String(index);
        item.textContent = option.textContent.trim();
        menu.append(item);
      });
      if (openControl?.select === select) positionMenu();
    }

    function positionMenu() {
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const up = spaceBelow < 180 && spaceAbove > spaceBelow;
      const available = Math.max(96, (up ? spaceAbove : spaceBelow) - 12);
      menu.style.left = `${Math.max(8, rect.left)}px`;
      menu.style.width = `${Math.min(rect.width, window.innerWidth - 16)}px`;
      menu.style.maxHeight = `${Math.min(280, available)}px`;
      menu.style.top = up ? '' : `${rect.bottom + 5}px`;
      menu.style.bottom = up ? `${window.innerHeight - rect.top + 5}px` : '';
    }

    function open() {
      if (trigger.disabled) return;
      close();
      refresh();
      menu.hidden = false;
      wrapper.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      openControl = { select, trigger, menu, wrapper };
      positionMenu();
      const selected = menu.querySelector('[aria-selected="true"]');
      (selected || menu.querySelector(':not(:disabled)'))?.focus({ preventScroll: true });
      selected?.scrollIntoView({ block: 'nearest' });
    }

    trigger.addEventListener('click', () => openControl?.select === select ? close({ restoreFocus: true }) : open());
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        open();
      }
    });
    menu.addEventListener('click', event => {
      const item = event.target.closest('.custom-select-option');
      if (!item || item.disabled) return;
      select.selectedIndex = Number(item.dataset.index);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      refresh();
      close({ restoreFocus: true });
    });
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('.custom-select-option:not(:disabled)')];
      const current = items.indexOf(document.activeElement);
      let index = current;
      if (event.key === 'ArrowDown') index = (current + 1) % items.length;
      else if (event.key === 'ArrowUp') index = (current - 1 + items.length) % items.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = items.length - 1;
      else if (event.key === 'Escape') { event.preventDefault(); close({ restoreFocus: true }); return; }
      else if (event.key === 'Tab') { close(); return; }
      else return;
      event.preventDefault();
      items[index]?.focus();
      items[index]?.scrollIntoView({ block: 'nearest' });
    });
    select.addEventListener('change', refresh);
    new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
    if (label) label.addEventListener('click', event => {
      if (event.target === label) { event.preventDefault(); open(); }
    });
    refresh();
  }

  document.addEventListener('pointerdown', event => {
    if (openControl && !openControl.wrapper.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openControl) close({ restoreFocus: true });
  });
  window.addEventListener('resize', () => { if (openControl) close(); });
  document.addEventListener('scroll', event => {
    if (openControl && !openControl.menu.contains(event.target)) close();
  }, true);
}
