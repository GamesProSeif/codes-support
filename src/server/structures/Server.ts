/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-var-requires */
import { Express, json, urlencoded, RequestHandler } from 'express';
import * as morgan from 'morgan';
import { join, resolve } from 'path';
import { Connection } from 'typeorm';
import { Logger } from 'winston';
import Database from './Database';
import Route from './Route';
import { readdirRecursive, parseRouteEndpoints } from '../../util';
import { logger, TOPICS, EVENTS } from '../../util/logger';
import { ERRORS, MESSAGES } from '../../util/constants';

// // Import and Set Nuxt.js options
// const { Nuxt, Builder } = require('nuxt');
// const config = require('../../nuxt.config.js');
// config.dev = process.env.NODE_ENV !== 'production';

export default class Server {
	public server: Express;
	public logger: Logger;
	public db!: Connection;
	public nuxt: any;
	public path: string;
	// public host: string;
	// public port: string;
	public readonly API_METHODS = resolve(join(__dirname, '..', 'api'));
	public readonly DEV = process.env.NODE_ENV === 'development';
	public methods: { [key: string]: Route } = {};
	public endpoints: { [key: string]: string } = {};

	public constructor(server: Express, path: string) {
		this.server = server;
		this.path = path;
		this.logger = logger;

		// // Init Nuxt.js
		// this.nuxt = new Nuxt(config);

		// const { host, port } = this.nuxt.options.server;
		// this.host = host;
		// this.port = port;

		// if (process.env.NODE_ENV === 'production') {
		// 	this.server.enable('trust proxy');
		// 	// this.server.use((req, res) => {
		// 	// 	if (!req.secure) {
		// 	// 		res.redirect(`https://${req.headers.host}${req.url}`);
		// 	// 	}
		// 	// });
		// }
	}

	private setMiddlewares() {
		// Body Parser Middleware
		this.server.use(json());
		this.logger.debug(MESSAGES.SERVER.MIDDLEWARES.LOADED('json'), { topic: TOPICS.EXPRESS, event: EVENTS.INIT });
		this.server.use(urlencoded({ extended: false }));
		this.logger.debug(MESSAGES.SERVER.MIDDLEWARES.LOADED('urlencoded'), { topic: TOPICS.EXPRESS, event: EVENTS.INIT });

		this.server.use(
			morgan(
				':method :url :status :remote-addr :response-time[3] :referrer',
				{
					stream: {
						write: (str: string) => this.logger.debug(str.replace('\n', ''), {
							topic: TOPICS.EXPRESS,
							event: EVENTS.ENDPOINT_HIT
						})
					}
				}
			)
		);
		this.logger.debug(MESSAGES.SERVER.MIDDLEWARES.LOADED('morgan'), { topic: TOPICS.EXPRESS, event: EVENTS.INIT });
	}

	public async init() {
		process.on('unhandledRejection', error => {
			this.logger.error((error as string), {
				topic: TOPICS.UNHANDLED_REJECTION,
				event: EVENTS.ERROR
			});
		});

		this.db = Database;
		await this.db.connect();
		this.logger.info(MESSAGES.DB.CONNECTED, { topic: TOPICS.TYPEORM, event: EVENTS.INIT });

		// // Build only in dev mode
		// if (config.dev) {
		// 	this.logger.info(MESSAGES.SERVER.NUXT.BUILD.DEV.BEGIN, { topic: TOPICS.NUXT, event: EVENTS.INIT });
		// 	const builder = new Builder(this.nuxt);
		// 	await builder.build();
		// 	this.logger.info(MESSAGES.SERVER.NUXT.BUILD.DEV.READY, { topic: TOPICS.NUXT, event: EVENTS.INIT });
		// } else {
		// 	this.logger.info(MESSAGES.SERVER.NUXT.BUILD.PROD.BEGIN, { topic: TOPICS.NUXT, event: EVENTS.INIT });
		// 	await this.nuxt.ready();
		// 	this.logger.info(MESSAGES.SERVER.NUXT.BUILD.PROD.BEGIN, { topic: TOPICS.NUXT, event: EVENTS.INIT });
		// }

		this.setMiddlewares();
		this.logger.info(MESSAGES.SERVER.MIDDLEWARES.ALL, { topic: TOPICS.EXPRESS, event: EVENTS.INIT });

		await this.loadAll();

		this.logger.info(
			MESSAGES.SERVER.HANDLER.LOADED(Object.values(this.methods).length, Object.values(this.endpoints).length),
			{
				topic: TOPICS.EXPRESS,
				event: EVENTS.INIT
			}
		);

		// this.server.get('/favicon.ico', (_, res) => res.redirect('/favicon.png'));

		// this.server.use(this.nuxt.render);
		// this.logger.debug(MESSAGES.SERVER.NUXT.RENDERER.LOADED, { topic: TOPICS.EXPRESS, event: EVENTS.INIT });

		// Listen the server
		this.server.listen(process.env.SERVER_PORT!);
		this.logger.info(MESSAGES.SERVER.LISTENING(process.env.SERVER_PORT!), {
			topic: TOPICS.EXPRESS,
			event: EVENTS.READY
		});
	}

	public register(file: Route): Route {
		if (Object.keys(this.methods).includes(file.id)) {
			throw new Error(ERRORS.SERVER.ROUTE_ALREADY_LOADED(file.id));
		}

		parseRouteEndpoints(file, this.path, this.endpoints);
		this.methods[file.id] = file;

		return file;
	}

	public async load(file: Route): Promise<Route> {
		const handler: RequestHandler = async (req, res, next): Promise<void> => {
			try {
				await file.exec(req, res, next);
			} catch (error) {
				this.logger.error(error, { topic: TOPICS.EXPRESS_HANDLER });
				res
					.status(500)
					.json({ error: error.message || ERRORS.SERVER.HANDLER_ERROR });
			}
		};

		if (file.middlewares) {
			// @ts-ignore
			this.server[file.method!](file.endpoint!, ...file.middlewares, handler);
		} else {
			// @ts-ignore
			this.server[file.method!](file.endpoint!, handler);
		}

		if (this.DEV) {
			this.logger.debug(MESSAGES.SERVER.HANDLER.ROUTE_LOADED(file.id), {
				topic: TOPICS.EXPRESS,
				event: EVENTS.INIT
			});
		}

		return file;
	}

	public async loadAll() {
		const methodFiles = readdirRecursive(this.API_METHODS);

		for (const method of methodFiles) {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const file: Route = new (require(method)).default();

			file.init({ logger: this.logger, db: this.db });

			this.register(file);
		}

		const files = Object.values(this.methods);
		files
			.sort((a, b) => a.order! - b.order!)
			.forEach(async file => {
				await this.load(file);
			});

		return this;
	}
}
