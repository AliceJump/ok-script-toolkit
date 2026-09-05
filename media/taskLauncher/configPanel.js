(() => {
  const { t, post, state, taskKey } = globalThis.TaskLauncherCore;
  const { buildField, fieldValue } = globalThis.TaskLauncherFields;

  const rulesOf = typeMeta => {
    const rules = typeMeta && typeof typeMeta.sub_configs === 'object' ? typeMeta.sub_configs : null;
    return rules && !Array.isArray(rules) ? rules : null;
  };
  const normalizeKeys = value => typeof value === 'string'
    ? [value]
    : (Array.isArray(value) ? value.filter(key => typeof key === 'string') : []);

  function booleanRules(field) {
    if (!field || (typeof field.default !== 'boolean' && typeof field.value !== 'boolean')) return null;
    const rules = rulesOf(field.type);
    if (!rules) return null;
    const result = {};
    for (const [choice, controlled] of Object.entries(rules)) {
      const normalized = String(choice).toLowerCase();
      if (normalized === 'true' || normalized === 'false') result[normalized] = normalizeKeys(controlled);
    }
    return Object.keys(result).length ? result : null;
  }

  function booleanValue(field, config) {
    const value = fieldValue(field, config);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
    return Boolean(value);
  }

  function optionGroups(field) {
    if (!field || booleanRules(field)) return [];
    const rules = rulesOf(field.type);
    if (!rules) return [];
    const labels = field.type?.sub_config_labels || {};
    return Object.entries(rules).map(([choice, controlled]) => ({
      key: String(choice),
      label: String(labels[choice] || choice),
      children: normalizeKeys(controlled),
    }));
  }

  function sectionTitle(text) {
    const title = document.createElement('div');
    title.className = 'config-section-title';
    title.textContent = text;
    return title;
  }

  function buildRuntimeFields(panel, config, onConfigChange) {
    const title = sectionTitle(t('launchSettings'));
    const savedBadge = document.createElement('span');
    savedBadge.className = 'config-saved';
    savedBadge.textContent = `✓ ${t('saved')}`;
    savedBadge.hidden = true;
    title.appendChild(savedBadge);
    panel.appendChild(title);

    let hideSavedTimer;
    const showSaved = () => {
      savedBadge.hidden = false;
      clearTimeout(hideSavedTimer);
      hideSavedTimer = setTimeout(() => { savedBadge.hidden = true; }, 1600);
    };

    const timeoutRow = document.createElement('div');
    timeoutRow.className = 'config-field';
    const timeoutLabel = document.createElement('label');
    timeoutLabel.className = 'config-field__label';
    timeoutLabel.textContent = t('timeoutSeconds');
    const timeoutHelp = document.createElement('div');
    timeoutHelp.className = 'config-field__description';
    timeoutHelp.textContent = t('timeoutHint');
    const timeout = document.createElement('input');
    timeout.type = 'number';
    timeout.min = '0';
    timeout.step = '1';
    timeout.value = String(config.timeout || 0);
    timeout.addEventListener('change', () => {
      const value = Number(timeout.value);
      if (value > 0) config.timeout = Math.min(value, 604800); else delete config.timeout;
      onConfigChange();
    });
    timeoutRow.append(timeoutLabel, timeoutHelp, timeout);
    panel.appendChild(timeoutRow);
    return showSaved;
  }

  function createActions(panel, config, hasSchemaFields, onConfigChange) {
    if (!hasSchemaFields) return;
    const actions = document.createElement('div');
    actions.className = 'config-actions';
    const reset = document.createElement('button');
    reset.className = 'secondary';
    reset.textContent = `↺ ${t('reset')}`;
    reset.addEventListener('click', () => {
      delete config.params;
      onConfigChange();
      globalThis.TaskLauncherTaskCard?.renderTasks?.(state.currentTasks);
    });
    actions.appendChild(reset);
    panel.appendChild(actions);
  }

  function buildConfigPanel(task, schema) {
    const panel = document.createElement('div');
    panel.className = 'config-panel';
    const saved = state.taskConfigs[taskKey(task)] || {};
    const config = { ...saved, params: { ...(saved.params || {}) } };

    // 修改即保存：字段变更直接落盘，无需点击保存按钮；状态同步到本地缓存供重渲染使用
    let showSaved = () => {};
    const persist = () => {
      state.taskConfigs[taskKey(task)] = config;
      post({ type: 'saveConfig', task, config });
      showSaved();
    };
    showSaved = buildRuntimeFields(panel, config, persist);

    if (schema?.broken) {
      const broken = document.createElement('div');
      broken.className = 'config-broken';
      broken.textContent = `⚠ ${t('schemaFailed', { error: schema.error || '' })}`;
      panel.appendChild(broken);
    } else if (schema?.fields?.length) {
      const host = document.createElement('div');
      host.className = 'config-fields';
      panel.appendChild(host);
      renderSchema(host, task, schema, config, persist);
    } else {
      const empty = document.createElement('div');
      empty.className = 'config-empty';
      empty.textContent = t('noConfigParameters');
      panel.appendChild(empty);
    }

    createActions(panel, config, Boolean(schema?.fields?.length), persist);
    return panel;
  }

  function renderSchema(host, task, schema, config, onConfigChange) {
    const fieldsByKey = Object.fromEntries(schema.fields.map(field => [field.key, field]));
    const groups = schema.configGroups && typeof schema.configGroups === 'object' ? schema.configGroups : {};
    const selectorKey = schema.groupSelector && fieldsByKey[schema.groupSelector] ? schema.groupSelector : '';
    const rowsByKey = {};
    const renderedFields = new Set();
    const renderedGroups = new Set();
    const inlineRules = {};

    for (const field of schema.fields) {
      const rules = booleanRules(field);
      if (rules) inlineRules[field.key] = rules;
    }

    const applyVisibility = () => {
      const parentsByChild = {};
      for (const [parent, rules] of Object.entries(inlineRules)) {
        for (const controlled of Object.values(rules)) {
          for (const child of controlled) (parentsByChild[child] ||= []).push(parent);
        }
      }
      const visible = (key, checking = new Set()) => {
        if (checking.has(key)) return false;
        const parents = parentsByChild[key] || [];
        if (!parents.length) return true;
        const next = new Set(checking); next.add(key);
        return parents.every(parentKey => {
          const parent = fieldsByKey[parentKey];
          if (!parent || !visible(parentKey, next)) return false;
          return (inlineRules[parentKey]?.[String(booleanValue(parent, config))] || []).includes(key);
        });
      };
      for (const [key, rows] of Object.entries(rowsByKey)) {
        for (const row of rows) row.hidden = !visible(key);
      }
    };

    const notifyChange = () => {
      applyVisibility();
      onConfigChange();
    };

    const renderField = (key, container, options = {}) => {
      if (!fieldsByKey[key] || (!options.duplicate && renderedFields.has(key))) return false;
      if (!options.duplicate) renderedFields.add(key);
      const row = buildField(container, fieldsByKey[key], config, notifyChange);
      row.classList.toggle('is-subconfig', options.subConfig === true);
      (rowsByKey[key] ||= []).push(row);
      return true;
    };

    let renderFieldTree;
    const renderGroup = (key, label, children, container, path, options = {}) => {
      if (renderedGroups.has(key)) return false;
      renderedGroups.add(key);
      const headerField = options.headerField && fieldsByKey[options.headerField] ? options.headerField : '';
      const childKeys = [...new Set(children)].filter(child => child && child !== headerField);

      const group = document.createElement('section');
      group.className = 'config-group';
      const header = document.createElement('div');
      header.className = 'config-group__header';
      if (headerField) {
        renderField(headerField, header, { duplicate: true });
      } else {
        const title = document.createElement('div');
        title.className = 'config-group__title';
        title.textContent = label;
        header.appendChild(title);
      }

      const toggle = document.createElement('button');
      toggle.className = 'config-group__toggle secondary';
      const body = document.createElement('div');
      body.className = 'config-group__body';
      const stateKey = `${taskKey(task)}::${path.join('>')}`;
      const setOpen = open => {
        group.classList.toggle('open', open);
        toggle.textContent = open ? '▲' : '▼';
        toggle.title = open ? t('collapseParameters') : t('parameters');
        state.openConfigGroups.set(stateKey, open);
      };
      toggle.addEventListener('click', () => setOpen(!group.classList.contains('open')));
      header.appendChild(toggle);
      group.append(header, body);
      container.appendChild(group);

      if (headerField && inlineRules[headerField]) {
        const checking = new Set(options.checking || []); checking.add(headerField);
        for (const child of [...new Set(Object.values(inlineRules[headerField]).flat())]) {
          renderFieldTree(child, body, [...path, child], { subConfig: true, checking });
        }
      }

      for (const child of childKeys) {
        if (groups[child]) {
          renderGroup(
            child,
            schema.groupLabels?.[child] || child,
            groups[child],
            body,
            [...path, child],
            { headerField: fieldsByKey[child] ? child : '', duplicateChildren: options.duplicateChildren },
          );
        } else {
          renderFieldTree(child, body, [...path, child], {
            duplicate: options.duplicateChildren,
            checking: options.checking || new Set(),
          });
        }
      }

      if (!body.childElementCount) {
        toggle.hidden = true;
        group.classList.add('open');
      } else {
        setOpen(state.openConfigGroups.get(stateKey) || false);
      }
      return true;
    };

    renderFieldTree = (key, container, path, options = {}) => {
      const checking = options.checking || new Set();
      if (checking.has(key) || !fieldsByKey[key]) return false;
      const next = new Set(checking); next.add(key);
      if (!renderField(key, container, options)) return false;

      const rules = inlineRules[key];
      if (rules) {
        for (const child of [...new Set(Object.values(rules).flat())]) {
          renderFieldTree(child, container, [...path, child], { subConfig: true, duplicate: options.duplicate, checking: next });
        }
      }
      for (const group of optionGroups(fieldsByKey[key])) {
        renderGroup(
          `${key}:${group.key}`,
          group.label,
          group.children,
          container,
          [...path, 'sub-config', group.key],
          { duplicateChildren: true },
        );
      }
      return true;
    };

    const optionControlled = new Set();
    for (const field of schema.fields) for (const group of optionGroups(field)) for (const key of group.children) optionControlled.add(key);
    const inlineControlled = new Set();
    for (const rules of Object.values(inlineRules)) for (const keys of Object.values(rules)) for (const key of keys) inlineControlled.add(key);
    const groupNames = new Set(Object.keys(groups));
    const groupChildren = new Set();
    for (const children of Object.values(groups)) if (Array.isArray(children)) for (const key of children) groupChildren.add(key);

    for (const field of schema.fields) {
      if (field.key === selectorKey || optionControlled.has(field.key) || inlineControlled.has(field.key) || groupNames.has(field.key) || groupChildren.has(field.key)) continue;
      renderFieldTree(field.key, host, ['field', field.key]);
    }

    const nestedGroups = new Set();
    for (const [parent, children] of Object.entries(groups)) {
      if (!Array.isArray(children)) continue;
      for (const child of children) if (child !== parent && groups[child]) nestedGroups.add(child);
    }
    const rootGroups = Object.keys(groups).filter(key => !nestedGroups.has(key));
    const renderRegisteredGroup = key => renderGroup(
      key,
      schema.groupLabels?.[key] || key,
      groups[key] || [],
      host,
      ['config-group', key],
      { headerField: fieldsByKey[key] ? key : '', duplicateChildren: true },
    );
    rootGroups.forEach(renderRegisteredGroup);
    Object.keys(groups).filter(key => !renderedGroups.has(key)).forEach(renderRegisteredGroup);

    for (const field of schema.fields) {
      if (field.key === selectorKey || renderedFields.has(field.key) || optionControlled.has(field.key) || groupNames.has(field.key) || groupChildren.has(field.key)) continue;
      renderFieldTree(field.key, host, ['remaining', field.key], { subConfig: inlineControlled.has(field.key) });
    }
    applyVisibility();
  }

  globalThis.TaskLauncherConfigPanel = { buildConfigPanel };
})();
