import { schedule, validate } from 'node-cron';
import { get } from 'micromustache';
import getDatabase from './database';
import emitter from './emitter';
import logger from './logger';
import { FlowsService } from './services';
import { EventHandler } from './types';
import { getSchema } from './utils/get-schema';
import { constructFlowTree } from './utils/construct-flow-tree';
import { OperationHandler, Operation, Flow, FilterHandler, ActionHandler, InitHandler } from '@directus/shared/types';
import env from './env';
import * as exceptions from './exceptions';
import * as sharedExceptions from '@directus/shared/exceptions';
import * as services from './services';
import { renderMustache } from './utils/render-mustache';

let flowManager: FlowManager | undefined;

export function getFlowManager(): FlowManager {
	if (flowManager) {
		return flowManager;
	}

	flowManager = new FlowManager();

	return flowManager;
}

const TRIGGER_KEY = '$trigger';
const LAST_KEY = '$last';

class FlowManager {
	private operations: Record<string, OperationHandler> = {};

	private triggerHandlers: EventHandler[] = [];

	public async initialize(): Promise<void> {
		const flowsService = new FlowsService({ knex: getDatabase(), schema: await getSchema() });

		const flows = await flowsService.readByQuery({
			filter: { status: { _eq: 'active' } },
			fields: ['*', 'operations.*'],
		});

		const flowTrees = flows.map((flow) => constructFlowTree(flow));

		for (const flow of flowTrees) {
			if (flow.trigger === 'filter') {
				const handler: FilterHandler = (payload, meta, context) =>
					this.executeFlow(
						flow,
						{ payload, ...meta },
						{
							accountability: context.accountability,
							database: context.database,
							getSchema: context.schema ? () => context.schema : getSchema,
						}
					);

				emitter.onFilter(flow.options.event, handler);

				this.triggerHandlers.push({ type: flow.trigger, name: flow.options.event, handler });
			} else if (flow.trigger === 'action') {
				const handler: ActionHandler = (meta, context) =>
					this.executeFlow(flow, meta, {
						accountability: context.accountability,
						database: context.database,
						getSchema: context.schema ? () => context.schema : getSchema,
					});

				emitter.onAction(flow.options.event, handler);

				this.triggerHandlers.push({ type: flow.trigger, name: flow.options.event, handler });
			} else if (flow.trigger === 'init') {
				const handler: InitHandler = () => this.executeFlow(flow);

				emitter.onInit(flow.options.event, handler);

				this.triggerHandlers.push({ type: flow.trigger, name: flow.options.event, handler });
			} else if (flow.trigger === 'schedule') {
				if (validate(flow.options.cron)) {
					const task = schedule(flow.options.cron, () => this.executeFlow(flow));

					this.triggerHandlers.push({ type: flow.trigger, task });
				} else {
					logger.warn(`Couldn't register cron trigger. Provided cron is invalid: ${flow.options.cron}`);
				}
			}
		}
	}

	public async reload(): Promise<void> {
		for (const trigger of this.triggerHandlers) {
			switch (trigger.type) {
				case 'filter':
					emitter.offFilter(trigger.name, trigger.handler);
					break;
				case 'action':
					emitter.offAction(trigger.name, trigger.handler);
					break;
				case 'init':
					emitter.offInit(trigger.name, trigger.handler);
					break;
				case 'schedule':
					trigger.task.stop();
					break;
			}
		}

		this.triggerHandlers = [];

		await this.initialize();
	}

	public addOperation(id: string, operation: OperationHandler): void {
		this.operations[id] = operation;
	}

	public clearOperations(): void {
		this.operations = {};
	}

	private async executeFlow(flow: Flow, data: unknown = null, context: Record<string, unknown> = {}): Promise<unknown> {
		const keyedData: Record<string, unknown> = { [TRIGGER_KEY]: data, [LAST_KEY]: data };

		let nextOperation = flow.operation;
		while (nextOperation !== null) {
			const { successor, data } = await this.executeOperation(nextOperation, keyedData, context);

			keyedData[nextOperation.key] = data;
			keyedData[LAST_KEY] = data;

			nextOperation = successor;
		}

		return flow.options.return ? get(keyedData, flow.options.return) : undefined;
	}

	private async executeOperation(
		operation: Operation,
		keyedData: Record<string, unknown>,
		context: Record<string, unknown> = {}
	): Promise<{ successor: Operation | null; data: unknown }> {
		if (!(operation.type in this.operations)) {
			logger.warn(`Couldn't find operation ${operation.type}`);

			return { successor: null, data: null };
		}

		const handler = this.operations[operation.type];

		const options = renderMustache(operation.options, keyedData);

		try {
			const result = await handler(options, {
				services,
				exceptions: { ...exceptions, ...sharedExceptions },
				env,
				database: getDatabase(),
				logger,
				getSchema,
				data: keyedData,
				accountability: null,
				...context,
			});

			return { successor: operation.resolve, data: result ?? null };
		} catch (error: unknown) {
			return { successor: operation.reject, data: error ?? null };
		}
	}
}