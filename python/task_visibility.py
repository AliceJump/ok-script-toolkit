# -*- coding: utf-8 -*-
"""Expose every registered task in toolkit development sessions.

ok-script's TaskManager normally drops tasks whose supported_languages does
not contain the active UI locale. A development launcher needs to inspect and
run those tasks as well, while still passing the selected locale to the app.
"""


def install_all_registered_tasks(locale=None):
    try:
        from ok.core.task_manager import TaskManager
    except ModuleNotFoundError:
        # ok-script 1.x keeps the class in this older, misspelled module.
        from ok.gui.tasks.TaskManger import TaskManager
        if locale:
            from ok.gui.common.config import Language, cfg
            for language in Language:
                if language.value.name() == locale:
                    cfg.language.value = language
                    break
    from ok.util.clazz import init_class_by_name

    if getattr(TaskManager.init_tasks, "_toolkit_all_tasks", False):
        return

    def init_tasks(self, task_classes):
        tasks = []
        for module_name, class_name in task_classes:
            task = init_class_by_name(
                module_name, class_name, executor=self.task_executor, app=self.app
            )
            task.after_init(executor=self.task_executor, scene=self.scene)
            tasks.append(task)
        return tasks

    init_tasks._toolkit_all_tasks = True
    TaskManager.init_tasks = init_tasks
