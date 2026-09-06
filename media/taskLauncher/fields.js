(() => {
  const { t } = globalThis.TaskLauncherCore;

  function currentValue(field, config) {
    return config.params && field.key in config.params
      ? config.params[field.key]
      : (field.value !== undefined ? field.value : field.default);
  }

  function createDescription(field) {
    const text = field.displayDesc || field.desc;
    if (!text) return null;
    const description = document.createElement('div');
    description.className = 'config-field__description';
    description.textContent = text;
    return description;
  }

  function createHint(text) {
    const hint = document.createElement('div');
    hint.className = 'config-field__hint';
    hint.textContent = text;
    return hint;
  }

  function createSelectOption(value, label, selected) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(label);
    option.selected = selected;
    return option;
  }

  function buildCascadeSelect(typeMeta, rawValue, setValue) {
    const select = document.createElement('select');
    let selected = false;
    for (const [category, values] of Object.entries(typeMeta.options || {})) {
      if (!Array.isArray(values)) continue;
      const group = document.createElement('optgroup');
      group.label = String(typeMeta.category_labels?.[category] || typeMeta.labels?.[category] || category);
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        const option = createSelectOption(
          JSON.stringify(value),
          typeMeta.option_labels?.[category]?.[index] || value,
          String(value) === String(rawValue),
        );
        if (option.selected) selected = true;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    if (!selected && rawValue !== undefined && rawValue !== null) {
      const group = document.createElement('optgroup');
      group.label = t('current');
      group.appendChild(createSelectOption(JSON.stringify(rawValue), t('currentValue', { value: rawValue }), true));
      select.insertBefore(group, select.firstChild);
    }
    select.addEventListener('change', () => {
      try { setValue(JSON.parse(select.value)); } catch { /* keep previous value */ }
    });
    return select;
  }

  function buildDropDown(typeMeta, options, optionLabels, rawValue, setValue) {
    const select = document.createElement('select');
    const current = String(rawValue ?? '');
    let hasCurrent = false;
    options.forEach((optionValue, index) => {
      const option = createSelectOption(index, optionLabels[index] || optionValue, String(optionValue) === current);
      if (option.selected) hasCurrent = true;
      select.appendChild(option);
    });
    if (!hasCurrent) select.appendChild(createSelectOption(-1, t('currentValue', { value: current }), true));
    select.addEventListener('change', () => {
      const index = Number(select.value);
      if (index >= 0 && index < options.length) setValue(options[index]);
    });
    return select;
  }

  function buildBoolean(rawValue, setValue) {
    const wrapper = document.createElement('label');
    wrapper.className = 'switch-field';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(rawValue);
    const state = document.createElement('span');
    state.className = 'switch-field__state';
    const syncLabel = () => { state.textContent = checkbox.checked ? t('enabled') : t('disabled'); };
    syncLabel();
    checkbox.addEventListener('change', () => {
      syncLabel();
      setValue(checkbox.checked);
    });
    wrapper.append(checkbox, state);
    return wrapper;
  }

  function buildNumber(typeMeta, rawValue, setValue) {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(rawValue);
    const minimum = typeMeta.minimum ?? typeMeta.min;
    const maximum = typeMeta.maximum ?? typeMeta.max;
    if (minimum !== undefined) input.min = String(minimum);
    if (maximum !== undefined) input.max = String(maximum);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      setValue(Number.isNaN(value) ? 0 : value);
    });
    return input;
  }

  function buildMultiSelection(options, optionLabels, rawValue, setValue) {
    const wrapper = document.createElement('div');
    const select = document.createElement('select');
    select.multiple = true;
    select.size = Math.min(7, options.length + 1);
    const selectedValues = (Array.isArray(rawValue) ? rawValue : []).map(String);
    options.forEach((optionValue, index) => {
      select.appendChild(createSelectOption(index, optionLabels[index] || optionValue, selectedValues.includes(String(optionValue))));
    });
    select.addEventListener('change', () => {
      setValue(Array.from(select.selectedOptions).map(option => options[Number(option.value)]));
    });
    wrapper.append(select, createHint(t('holdCtrlMulti')));
    return wrapper;
  }

  function buildStructuredList(rawValue, setValue) {
    const wrapper = document.createElement('div');
    const textarea = document.createElement('textarea');
    textarea.value = JSON.stringify(Array.isArray(rawValue) ? rawValue : [], null, 2);
    textarea.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(textarea.value);
        if (!Array.isArray(parsed)) throw new Error();
        textarea.classList.remove('config-json-error');
        setValue(parsed);
      } catch {
        textarea.classList.add('config-json-error');
      }
    });
    wrapper.append(textarea, createHint(t('structuredJsonHint')));
    return wrapper;
  }

  function buildList(typeMeta, rawValue, setValue, field) {
    // 复刻框架 ModifyListItem + ModifyListDialog 语义：
    // 折叠态显示当前项摘要 + 「修改」按钮；弹窗内按有无 options_available 分两种模式。
    const items = Array.isArray(rawValue) ? rawValue : [];
    const available = Array.isArray(typeMeta.options_available) ? typeMeta.options_available : null;
    const labels = Array.isArray(typeMeta.options_available_labels) ? typeMeta.options_available_labels : [];
    const allowDup = typeMeta.allow_duplication === true;
    const labelFor = value => {
      if (!available) return String(value);
      const index = available.findIndex(option => String(option) === String(value));
      return index >= 0 ? String(labels[index] ?? value) : String(value);
    };

    const wrapper = document.createElement('div');
    wrapper.className = 'list-editor';

    const summaryText = items.map(labelFor);
    const summary = document.createElement('div');
    summary.className = 'list-editor__summary';
    summary.textContent = summaryText.join('').length > 30 || items.length > 3
      ? summaryText.join('\n')
      : (summaryText.join(', ') || '—');
    wrapper.appendChild(summary);

    const modify = document.createElement('button');
    modify.type = 'button';
    modify.className = 'secondary list-editor__modify';
    modify.textContent = t('modify');
    modify.addEventListener('click', () => {
      openListDialog({
        title: field?.displayKey || field?.key || '',
        items,
        available,
        labels,
        allowDup,
        labelFor,
        apply: value => setValue(value),
      });
    });
    wrapper.appendChild(modify);
    return wrapper;
  }

  // 与框架 ModifyListDialog.SHOW_SEARCH_OPTIONS_THRESHOLD 一致
  const LIST_DIALOG_SEARCH_THRESHOLD = 20;

  function openListDialog({ title, items, available, labels, allowDup, labelFor, apply }) {
    const working = available
      ? items.filter(value => available.some(option => String(option) === String(value)))
      : items.slice();
    let selectedRow = -1;

    const backdrop = document.createElement('div');
    backdrop.className = 'list-dialog__backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'list-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;

    const titleNode = document.createElement('div');
    titleNode.className = 'list-dialog__title';
    titleNode.textContent = title || t('modify');
    dialog.appendChild(titleNode);

    const body = document.createElement('div');
    body.className = 'list-dialog__body';
    dialog.appendChild(body);

    const listNode = document.createElement('ul');
    listNode.className = 'list-dialog__list';

    const upButton = document.createElement('button');
    upButton.type = 'button';
    upButton.className = 'secondary';
    upButton.textContent = t('moveUp');
    const downButton = document.createElement('button');
    downButton.type = 'button';
    downButton.className = 'secondary';
    downButton.textContent = t('moveDown');
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'secondary';
    removeButton.textContent = t('removeItem');

    const renderList = () => {
      listNode.replaceChildren();
      working.forEach((value, index) => {
        const row = document.createElement('li');
        row.className = 'list-dialog__row' + (index === selectedRow ? ' selected' : '');
        row.textContent = labelFor(value);
        row.addEventListener('click', () => {
          selectedRow = index;
          renderList();
        });
        listNode.appendChild(row);
      });
      syncActionStates();
    };

    const syncActionStates = () => {
      upButton.disabled = selectedRow <= 0;
      downButton.disabled = selectedRow < 0 || selectedRow >= working.length - 1;
      removeButton.disabled = selectedRow < 0;
      if (optionButtons) {
        for (const [value, button] of optionButtons) {
          const taken = working.some(item => String(item) === String(value));
          button.disabled = !allowDup && taken;
        }
      }
    };

    const move = delta => {
      const target = selectedRow + delta;
      if (target < 0 || target >= working.length) return;
      [working[selectedRow], working[target]] = [working[target], working[selectedRow]];
      selectedRow = target;
      renderList();
    };
    upButton.addEventListener('click', () => move(-1));
    downButton.addEventListener('click', () => move(1));
    removeButton.addEventListener('click', () => {
      if (selectedRow < 0) return;
      working.splice(selectedRow, 1);
      selectedRow = -1;
      renderList();
    });

    const addValue = value => {
      if (!allowDup && working.some(item => String(item) === String(value))) return;
      working.push(value);
      selectedRow = working.length - 1;
      renderList();
    };

    let optionButtons = null;
    if (available) {
      // 双栏模式：左侧可用选项按钮流，右侧已选列表（与框架 ModifyListDialog 布局一致）
      const optionsPane = document.createElement('div');
      optionsPane.className = 'list-dialog__pane';

      const optionsTitle = document.createElement('div');
      optionsTitle.className = 'list-dialog__subtitle';
      optionsTitle.textContent = t('availableOptions');
      const optionsHint = document.createElement('div');
      optionsHint.className = 'list-dialog__hint';
      optionsHint.textContent = t('clickOptionToAdd');
      optionsPane.append(optionsTitle, optionsHint);

      let searchInput = null;
      if (available.length > LIST_DIALOG_SEARCH_THRESHOLD) {
        searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'list-dialog__search';
        searchInput.placeholder = t('searchOptions');
        optionsPane.appendChild(searchInput);
      }

      const optionsFlow = document.createElement('div');
      optionsFlow.className = 'list-dialog__options';
      optionButtons = new Map();
      available.forEach((value, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary list-dialog__option';
        button.textContent = String(labels[index] ?? value);
        button.addEventListener('click', () => addValue(value));
        optionsFlow.appendChild(button);
        optionButtons.set(value, button);
      });
      optionsPane.appendChild(optionsFlow);
      if (searchInput) {
        searchInput.addEventListener('input', () => {
          const keyword = searchInput.value.trim().toLowerCase();
          for (const [value, button] of optionButtons) {
            const haystack = `${value}`.toLowerCase();
            const needle = String(labels[available.indexOf(value)] ?? value).toLowerCase();
            button.hidden = Boolean(keyword) && !haystack.includes(keyword) && !needle.includes(keyword);
          }
        });
      }

      const selectedPane = document.createElement('div');
      selectedPane.className = 'list-dialog__pane list-dialog__pane--narrow';
      const selectedTitle = document.createElement('div');
      selectedTitle.className = 'list-dialog__subtitle';
      selectedTitle.textContent = t('selectedOptions');
      const selectedBody = document.createElement('div');
      selectedBody.className = 'list-dialog__columns';
      const actions = document.createElement('div');
      actions.className = 'list-dialog__actions';
      actions.append(upButton, downButton, removeButton);
      selectedBody.append(listNode, actions);
      selectedPane.append(selectedTitle, selectedBody);
      body.append(optionsPane, selectedPane);
    } else {
      // 自由编辑模式：列表 + 文本添加行 + 上移/下移/移除
      const pane = document.createElement('div');
      pane.className = 'list-dialog__pane';
      const selectedTitle = document.createElement('div');
      selectedTitle.className = 'list-dialog__subtitle';
      selectedTitle.textContent = t('selectedOptions');
      pane.appendChild(selectedTitle);

      const selectedBody = document.createElement('div');
      selectedBody.className = 'list-dialog__columns';
      const actions = document.createElement('div');
      actions.className = 'list-dialog__actions';
      actions.append(upButton, downButton, removeButton);
      selectedBody.append(listNode, actions);
      pane.appendChild(selectedBody);

      const addRow = document.createElement('div');
      addRow.className = 'list-dialog__add-row';
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.placeholder = t('addValue');
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.textContent = t('add');
      addButton.disabled = true;
      addInput.addEventListener('input', () => { addButton.disabled = !addInput.value.trim(); });
      const submit = () => {
        const text = addInput.value.trim();
        if (!text) return;
        addValue(text);
        addInput.value = '';
        addButton.disabled = true;
        addInput.focus();
      };
      addButton.addEventListener('click', submit);
      addInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      addRow.append(addInput, addButton);
      pane.appendChild(addRow);
      body.appendChild(pane);
    }

    const footer = document.createElement('div');
    footer.className = 'list-dialog__footer';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'secondary';
    cancelButton.textContent = t('cancel');
    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.textContent = t('confirm');
    footer.append(cancelButton, confirmButton);
    dialog.appendChild(footer);

    const close = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    confirmButton.addEventListener('click', () => {
      apply(working.slice());
      close();
    });
    cancelButton.addEventListener('click', close);
    backdrop.addEventListener('mousedown', event => {
      if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', onKeyDown, true);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    dialog.focus();
    renderList();
  }

  function buildText(rawValue, setValue, multiline) {
    const input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = 'text';
    input.value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
    input.addEventListener('change', () => setValue(input.value));
    return input;
  }

  function buildField(container, field, config, onChange) {
    const row = document.createElement('div');
    row.className = 'config-field';
    row.dataset.key = field.key;

    const label = document.createElement('label');
    label.className = 'config-field__label';
    label.textContent = field.displayKey || field.key;
    label.title = field.key;
    row.appendChild(label);
    const description = createDescription(field);
    if (description) row.appendChild(description);

    const setValue = value => {
      config.params ||= {};
      config.params[field.key] = value;
      onChange?.();
    };
    const typeMeta = field.type || {};
    const typeName = String(typeMeta.type || '');
    const options = Array.isArray(typeMeta.options) ? typeMeta.options : [];
    const optionLabels = Array.isArray(typeMeta.option_labels) ? typeMeta.option_labels : [];
    const rawValue = currentValue(field, config);

    let control;
    if (typeName === 'cascade_drop_down' && typeMeta.options && typeof typeMeta.options === 'object') {
      control = buildCascadeSelect(typeMeta, rawValue, setValue);
    } else if ((typeName === 'drop_down' || (!typeName && options.length && !Array.isArray(rawValue))) && options.length) {
      control = buildDropDown(typeMeta, options, optionLabels, rawValue, setValue);
    } else if (typeof rawValue === 'boolean') {
      control = buildBoolean(rawValue, setValue);
    } else if (typeof rawValue === 'number') {
      control = buildNumber(typeMeta, rawValue, setValue);
    } else if (Array.isArray(rawValue) && (typeName === 'multi_selection' || (!typeName && options.length)) && options.length) {
      control = buildMultiSelection(options, optionLabels, rawValue, setValue);
    } else if (typeName === 'cond_sequence_editor' || (Array.isArray(rawValue) && rawValue.some(item => item && typeof item === 'object'))) {
      control = buildStructuredList(rawValue, setValue);
    } else if (Array.isArray(rawValue)) {
      control = buildList(typeMeta, rawValue, setValue, field);
    } else {
      const multiline = typeof rawValue === 'string' && (typeName === 'text_edit' || rawValue.includes('\n') || rawValue.length > 80);
      control = buildText(rawValue, setValue, multiline);
    }

    row.appendChild(control);
    container.appendChild(row);
    return row;
  }

  globalThis.TaskLauncherFields = { buildField, fieldValue: currentValue };
})();
