"""Execute the unmodified Python lesson as the reference for TS differential tests.

Uses only fake model responses; no API access. Run in a disposable working directory.
"""
import contextlib
import asyncio
import dataclasses
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types


def plain(value):
    if dataclasses.is_dataclass(value):
        return plain(dataclasses.asdict(value))
    if isinstance(value, types.SimpleNamespace):
        return {key: plain(item) for key, item in vars(value).items()}
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if isinstance(value, (Path, set)):
        return str(value) if isinstance(value, Path) else sorted(value)
    return value


def main():
    root = Path(__file__).resolve().parents[2]
    chapter = sys.argv[1]
    data = json.load(sys.stdin)
    requests = []
    replies = list(data.get('replies', []))

    def create(**kwargs):
        requests.append(plain(copy.deepcopy(kwargs)))
        reply = replies.pop(0)
        if 'error' in reply:
            raise RuntimeError(reply['error'])
        return types.SimpleNamespace(
            content=[types.SimpleNamespace(**block) for block in reply['content']],
            usage=types.SimpleNamespace(input_tokens=10, output_tokens=5),
            stop_reason=reply.get('stop_reason', 'end_turn'),
        )

    class FakeAnthropic:
        def __init__(self, *args, **kwargs):
            self.messages = types.SimpleNamespace(create=create)

    sys.modules['anthropic'] = types.SimpleNamespace(Anthropic=FakeAnthropic)
    sys.modules['dotenv'] = types.SimpleNamespace(load_dotenv=lambda **kwargs: None)
    os.environ['MODEL_ID'] = 'offline'
    module_name = 'parity_' + chapter
    spec = importlib.util.spec_from_file_location(module_name, root / chapter if chapter.endswith('.py') else root / chapter / 'code.py')
    lesson = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = lesson
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(lesson)
        result = None
        scenario = data.get('scenario', 'schemas')
        if scenario == 'schemas':
            result = {name: getattr(lesson, name) for name in data.get('names', ['TOOLS'])}
        elif scenario == 'subagent':
            result = lesson.run_subagent(data['prompt'])
        elif scenario == 'frontmatter':
            result = [lesson.SkillLoader.parse_frontmatter(text) for text in data['texts']]
        elif scenario == 'compactor':
            compact = lesson.ContextCompactor(lesson.client, 'offline', Path.cwd() / 'transcripts', Path.cwd() / 'outputs')
            result = []
            for call in data['calls']:
                target = getattr(compact, call['method'])
                result.append(plain(target(*copy.deepcopy(call.get('args', [])))))
        elif scenario == 'workflow':
            lesson.STORE = Path.cwd() / 'workflow-store'
            result = asyncio.run(lesson.run_workflow(
                'review-changes', {'budget': None, 'changes': lesson.DEMO_CHANGES}
            ))
        elif scenario == 'workflow_primitives':
            result = []
            journal = lesson.WorkflowJournal('wf_test_0123456789abcdef', False, Path.cwd() / 'journal')
            try:
                for call in data['calls']:
                    if call['kind'] == 'schema':
                        result.append(lesson.SimpleJsonSchema(call['schema']).validate(call['value']))
                    elif call['kind'] == 'runner':
                        result.append(plain(lesson.MockAgentRunner().run(call['prompt'], call.get('schema'), call.get('label'))))
                    elif call['kind'] == 'key':
                        result.append(journal.key('agent', call['label'], call['prompt'], call.get('schema')))
            finally:
                journal.close()
        elif scenario == 'goal_session':
            lesson.time.time = lambda: 1000
            evaluations = list(data.get('evaluations', []))
            class Evaluator:
                async def evaluate(self, condition, messages):
                    return lesson.GoalEvaluation(**evaluations.pop(0))
            goal = lesson.GoalController(Evaluator(), block_cap=data.get('block_cap', 8))
            session = lesson.AgentSession(FakeAnthropic(), 'offline', goal, Path.cwd(), max_turns=data.get('max_turns'))
            results = [plain(asyncio.run(session.submit(query))) for query in data['queries']]
            result = {'results': results, 'messages': session.messages, 'total_tokens': session.total_tokens,
                      'events': goal.events}
        elif scenario == 'evaluator_prompt':
            evaluator = lesson.PromptGoalEvaluator(FakeAnthropic(), 'offline')
            result = plain(asyncio.run(evaluator.evaluate(data['condition'], data['messages'])))
        elif scenario == 'todos':
            result = []
            for value in data['values']:
                try:
                    if hasattr(lesson, 'TodoManager'):
                        result.append(lesson.TodoManager().update(value))
                    else:
                        normalized, error = lesson._normalize_todos(value)
                        result.append(error if error else 'ok')
                except Exception as error:
                    result.append('Error: ' + str(error))
        elif scenario == 'handler_binding':
            handlers = getattr(lesson, data['table'])
            result = []
            for call in data['calls']:
                try:
                    result.append(str(handlers[call['name']](**call['input'])))
                except Exception as error:
                    result.append(type(error).__name__ + ': ' + str(error))
        elif scenario == 'reference_agent':
            history = []
            value = lesson.agent(data['prompt'], history)
            result = {'value': value, 'history': history}
        elif scenario == 'reference_subagent':
            value = lesson.run_task('inspect', data['prompt'], 'explore', FakeAnthropic(), 'offline', Path.cwd(),
                                    data['tools'], lambda name, args: 'tool output')
            result = value
        elif scenario == 'functions':
            result = []
            for call in data['calls']:
                result.append(plain(getattr(lesson, call['name'])(*call.get('args', []))))
        else:
            raise ValueError('Unknown scenario: ' + scenario)
    print(json.dumps({'result': plain(result), 'requests': requests}, ensure_ascii=False))


if __name__ == '__main__':
    main()
