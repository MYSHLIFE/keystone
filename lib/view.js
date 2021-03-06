/*!
 * Module dependencies.
 */
var _ = require('underscore'),
	keystone = require('../'),
	async = require('async'),
	utils = require('keystone-utils');

/**
 * View Constructor
 * =================
 *
 * Helper to simplify view logic in a Keystone application
 *
 * @api public
 */
function View(req, res) {

	if (!req || req.constructor.name != 'IncomingMessage') {
		throw new Error('Keystone.View Error: Express request object is required.');
	}

	if (!res || res.constructor.name != 'ServerResponse') {
		throw new Error('Keystone.View Error: Express response object is required.');
	}

	this.req = req;
	this.res = res;

	this.initQueue = [];	// executed first in series
	this.actionQueue = [];	// executed second in parallel, if optional conditions are met
	this.queryQueue = [];	// executed third in parallel
	this.renderQueue = [];	// executed fourth in parallel

}

module.exports = exports = View;


/**
 * Adds a method (or array of methods) to be executed in parallel
 * to the `init`, `action` or `render` queue.
 *
 * @api public
 */
View.prototype.on = function(on) {

	var req = this.req,
		callback = arguments[1],
		values;
  // If the first argument is a function that returns truthy then add the second
  // argument to the action queue
  // ex.
  //     view.on(function () {
  //         var thing = true
  //         return thing
  //       },
  //       function (next) {
  //         console.log('thing is true!')
  //         next()
  //       }
  //     )
	if ('function' == typeof on) {

		if (on()) {
			this.actionQueue.push(callback);
		}

	} else if (utils.isObject(on)) {
    // Do certain actions depending on information in the response object.
    // ex.
    //     view.on({'user.name.first': 'Admin'}, function (next) {
    //       console.log('Hello Admin!')
    //       next()
    //     })
		var check = function(value, path) {

			var ctx = req,
				parts = path.split('.');

			for (var i = 0; i < parts.length - 1; i++) {
				if (!ctx[parts[i]]) {
					return false;
				}
				ctx = ctx[parts[i]];
			}

			return (value === true && path in ctx) ? true : (ctx[path] == value);

		};

		if (_.every(on, check)) {
			this.actionQueue.push(callback);
		}

	} else if (on == 'get' || on == 'post' || on == 'put' || on == 'delete') {
    // Handle HTTP verbs
    // ex.
    //     view.on('get', function (next) {
    //       console.log('GOT!')
    //       next()
    //     })
		if (req.method != on.toUpperCase()) {
			return;
		}

		if (arguments.length == 3) {
      // on a POST and PUT requests search the req.body for a matching value
      // on every other request search the query.
      // ex.
      //     view.on('post', {action: 'theAction'}, function (next) {
      //       // respond to the action.
      //       next()
      //     })
      // ex.
      //     view.on('get', {page: 2}, function (next) {
      //       // do something specifically on ?page=2
      //       next()
      //     })
			if (utils.isString(callback)) {
				values = {};
				values[callback] = true;
			} else {
				values = callback;
			}

			callback = arguments[2];

			var ctx = (on == 'post' || on == 'put') ? req.body : req.query;

			if (_.every(values || {}, function(value, path) {
				return (value === true && path in ctx) ? true : (ctx[path] == value);
			})) {
				this.actionQueue.push(callback);
			}

		} else {
			this.actionQueue.push(callback);
		}

	} else if (on == 'init') {
    // ex.
    //     view.on('init', function (next) {
    //       // the first things to do on a view
    //       // these are fired in series
    //     })
		this.initQueue.push(callback);
	} else if (on == 'render') {
    // ex.
    //     view.render(function () {
    //       // dynamically determine which view to render via a function
    //     })
    // ex.
    //    view.render('Home') // or just render a specific view
		this.renderQueue.push(callback);
	}

	return this;
};


/**
 * Queues a mongoose query for execution before the view is rendered.
 * The results of the query are set in `locals[key]`.
 *
 * Keys can be nested paths, containing objects will be created as required.
 *
 * The third argument `then` can be a method to call after the query is completed
 * like function(err, results, callback), or a `populatedRelated` definition
 * (string or array).
 *
 * @api public
 */
var QueryCallbacks = function(options) {
	if (utils.isString(options)) {
		options = { then: options };
	} else {
		options = options || {};
	}
	this.callbacks = {};
	if (options.err) this.callbacks.err = options.err;
	if (options.none) this.callbacks.none = options.none;
	if (options.then) this.callbacks.then = options.then;
	return this;
};

QueryCallbacks.prototype.has = function(fn) { return (fn in this.callbacks); };
QueryCallbacks.prototype.err = function(fn) { this.callbacks.err = fn; return this; };
QueryCallbacks.prototype.none = function(fn) { this.callbacks.none = fn; return this; };
QueryCallbacks.prototype.then = function(fn) { this.callbacks.then = fn; return this; };

// ex.
//     view.query('books', keystone.list('Book').model.find())
// an array of books from the database will be added to locals.books. You can
// also nest properties on the locals variable.
// ex.
//     view.query(
//       'admin.books',
//       keystone.list('Book').model.find().where('user', 'Admin')
//     )
// locals.admin.books will be the result of the query
View.prototype.query = function(key, query, options) {

	var locals = this.res.locals,
		parts = key.split('.'),
		chain = new QueryCallbacks(options);
    key = parts.pop();

	for (var i = 0; i < parts.length; i++) {
		if (!locals[parts[i]]) {
			locals[parts[i]] = {};
		}
		locals = locals[parts[i]];
	}

	this.queryQueue.push(function(next) {
		query.exec(function(err, results) {

			locals[key] = results;
			callbacks = chain.callbacks;

			if (err) {
				if ('err' in callbacks) {
          // will pass errors into the err callback
          // ex.
          //     view.query('books', keystone.list('Book'))
          //       .err(function (err, next) {
          //         console.log('ERROR: ', err)
          //         next()
          //       })
					return callbacks.err(err, next);
				}
			} else {
				if ((!results || (utils.isArray(results) && !results.length)) && 'none' in callbacks) {
          // if there are no results view.query().none will be called
          // ex.
          //     view.query('books', keystone.list('Book').model.find())
          //       .none(function (next) {
          //         console.log('no results')
          //         next()
          //       })
					return callbacks.none(next);
				} else if ('then' in callbacks) {
					if (utils.isFunction(callbacks.then)) {
            // views.query().then is always called if it is available
            // ex.
            //     view.query('books', keystone.list('Book').model.find())
            //       .then(function (err, results, next) {
            //         if (err) return next(err)
            //         console.log(results)
            //         next
            //       })
						return callbacks.then(err, results, next);
					} else {
						return keystone.populateRelated(results, callbacks.then, next);
					}
				}
			}

			return next(err);

		});
	});

	return chain;
};


/**
 * Executes the current queue of init and action methods in series, and
 * then executes the render function. If renderFn is a string, it is provided
 * to `res.render`.
 *
 * It is expected that *most* init stacks require processing in series,
 * but it is safe to execute actions in parallel.
 *
 * If there are several init methods that should be run in parallel, queue
 * them as an array, e.g. `view.on('init', [first, second])`.
 *
 * @api public
 */
View.prototype.render = function(renderFn, locals, callback) {

	var req = this.req,
		res = this.res;

	if ('string' == typeof renderFn) {
		var viewPath = renderFn;
		renderFn = (function() {
			if ('function' == typeof locals) {
				locals = locals();
			}
			this.res.render(viewPath, locals, callback);
		}).bind(this);
	}

	if ('function' != typeof renderFn) {
		throw new Error('Keystone.View.render() renderFn must be a templatePath (string) or a function.');
	}

	// Add actions, queries & renderQueue to the end of the initQueue
	this.initQueue.push(this.actionQueue);
	this.initQueue.push(this.queryQueue);

	var preRenderQueue = [];

	// Add Keystone's global pre('render') queue
	keystone._pre.render.forEach(function(fn) {
		preRenderQueue.push(function(next) {
			fn(req, res, next);
		});
	});

	this.initQueue.push(preRenderQueue);
	this.initQueue.push(this.renderQueue);

	async.eachSeries(this.initQueue, function(i, next) {
		if (Array.isArray(i)) {
			// process nested arrays in parallel
			async.parallel(i, next);
		} else if ('function' == typeof i) {
			// process single methods in series
			i(next);
		} else {
			throw new Error('Keystone.View.render() events must be functions.');
		}
	}, function(err) {
		renderFn(err);
	});

};
