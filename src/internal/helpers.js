const api = require('../util/api');
const ldap = require('ldapjs');

/**
 *  Private helper functions
 *  --------------------------
 *  _getBoundClient()
 *  _findByType(opts, membership)
 *  _search(filter, config)
 *  _getGroupUsers(groupName)
 *  _addObject(name, location, userObject)
 *  _deleteObjectBySearch(searchString)
 *  _deleteObjectByDN(dn)
 *  _modifyDN(oldDN, newDN)
 */

module.exports = {

	_getBoundClient() {
		return new Promise((resolve, reject) => {
			const client = ldap.createClient({
			    url: this.config.url,
			    tlsOptions: {
			    	rejectUnauthorized: false
			    }
			});

	        client.bind(this.config.user, this.config.pass, function(err, data) {  
	        	resolve([err, client]);
	        });
		});
	},

	_findByType(opts, membership) {
		opts = opts || {};
		let cacheKey = JSON.stringify(membership);
		return new Promise((resolve, reject) => {
			let cached = this._cache.get('all', cacheKey);
			if (cached) {
				return resolve(api.processResults(opts, cached));
			}
			const domain = this.config.domain;
			const config = {
				query: `CN=*`,
			  	includeMembership: membership,
			  	includeDeleted: false
			};

			this.ad.find(config, (err, results) => {
				if (err) {
					/* istanbul ignore next */
					return reject(err);
				}

				if (!results || results.length < 1) {
					/* istanbul ignore next */
					return resolve([]);
				}

				if (membership.indexOf('all') > -1) {
					this._cache.set('all', cacheKey, results);
					return resolve(api.processResults(opts, results));
				}

				let compiled = [];
				if (membership.indexOf('user') > -1) {
					compiled = compiled.concat(results.users);
				}

				if (membership.indexOf('group') > -1) {
					compiled = compiled.concat(results.groups);
				}

				if (membership.indexOf('other') > -1) {
					compiled = compiled.concat(results.other);
				}

				this._cache.set('all', cacheKey, compiled);
				resolve(api.processResults(opts, compiled));
			});
		});
	},

	_search(filter, config) {
		return new Promise((resolve, reject) => {
			const opts = {
				filter,
			  	includeDeleted: false
			};
			try {
				this.ad.find(opts, (err, results) => {
					if (err) {
						/* istanbul ignore next */
						return reject(err);
					}
					if (!results) {
						return resolve([]);
					}
					if (config) {
						let combined = [];
						for (const key in results) {
							if (Array.isArray(results[key])) {
								combined = combined.concat(results[key]);
							}
						}
						combined = api.processResults(config, combined);
						results = combined;
					}
					return resolve(results);
				});
			} catch(e) {
				/* istanbul ignore next */
				return reject({message: e.message, type: e.type, stack: e.stack});
			}
		});
	},

	_getGroupUsers(groupName) {
		return new Promise((resolve, reject) => {
			this.ad.getUsersForGroup(groupName, (err, users) => {
			  if (err) {
				/* istanbul ignore next */
			    return reject({message: err.message});
			  }
			  if (!users) {
				/* istanbul ignore next */
			  	return reject({message: `Group ${groupName} does not exist.`});
			  }
			  return resolve(users);
			});
		});
	},

	_addObject(name, location, object) {
		return new Promise(async (resolve, reject) => {
			let baseDN = String(this.config.baseDN).replace(/dc=/g, 'DC=');
			let fullDN = String(`${name},${location}${baseDN}`);
			const [error, client] = await this._getBoundClient();
			if (error) {
				/* istanbul ignore next */
				return reject(error);
			}
			for (const key in object) {
				if (object[key] === undefined) {
					delete object[key];
				}
			}
			client.add(fullDN, object, (err, data) => {
				if (error) {
					/* istanbul ignore next */
					return reject(error);
				}
				delete object.userPassword;
				resolve(object);
			});
		});
	},

	_deleteObjectBySearch(searchString) { // todo
		return new Promise((resolve, reject) => {
			this._search(searchString, {fields: ['dn']}).then(results => {
				if (results.length < 1) {
					/* istanbul ignore next */
					return reject({message: `Object ${searchString} does not exist.`});
				}
				if (results.length > 1) {
					/* istanbul ignore next */
					return reject({message: `More than 1 Object was returned.`});
				}
				this._deleteObjectByDN(results[0].dn).then(result => {
					resolve(result);
				}).catch(reject);
			}).catch(reject);
		});
	},

	_deleteObjectByDN(dn) {
		return new Promise(async (resolve, reject) => {
			const [error, client] = await this._getBoundClient();
			if (error) {
				/* istanbul ignore next */
				return reject(error);
			}
			client.del(dn, (err, data) => {
				if (error) {
					/* istanbul ignore next */
					return reject(error);
				}
				resolve({success: true});
			});
		});
	},

	_modifyDN(oldDN, newDN) {
		return new Promise(async (resolve, reject) => {
			const [error, client] = await this._getBoundClient();
			if (error) {
				/* istanbul ignore next */
				return reject(error);
			}
			try {
				client.modifyDN(oldDN, newDN, (err) => {
				    if (err) {
						/* istanbul ignore next */
				    	return reject({message: err.message});
				    }
				    return resolve({success: true});
				});	
			} catch(e) {
				return reject({message: e.message});
			}
		});
	}

}
