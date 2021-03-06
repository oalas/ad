const ssha = require('node-ssha256');
const api = require('./util/api');
const encodePassword = require('./util/encodePassword');
const wrapAsync = require('./util/wrapAsync');
const parseLocation = require('./util/parseLocation');

/**
 *  Public user functions
 *  --------------------------
 *  findUser(userName, opts)
 *  addUser(opts)
 *  userExists(userName)
 *  userIsMemberOf(userName, groupName)
 *  authenticateUser(userName, pass)
 *  setUserPassword(userName, pass)
 *  setUserPasswordNeverExpires(userName)
 *  enableUser(userName)
 *  disableUser(userName)
 *  moveUser(userName, location)
 *  getUserLocation(userName)
 *  unlockUser(userName)
 *  removeUser(userName)
 */

module.exports = {
  async getAllUsers(opts) {
    return await this._findByType(opts, ['user']);
  },

  addUser(opts) {
    return new Promise((resolve, reject) => {
      let {
        firstName,
        lastName,
        commonName,
        userName,
        pass,
        email,
        title,
        phone,
        location
      } = opts;

      let { passwordExpires, enabled } = opts;

      if (commonName) {
        let cnParts = String(commonName).split(' ');
        firstName = firstName ? firstName : cnParts[0];
        if (cnParts.length > 1) {
          lastName = lastName ? lastName : cnParts[cnParts.length - 1];
        }
      } else {
        if (firstName && lastName) {
          commonName = `${firstName} ${lastName}`;
        }
      }

      location = parseLocation(location);

      let valid =
        email && String(email).indexOf('@') === -1
          ? 'Invalid email address.'
          : !commonName
          ? 'A commonName is required.'
          : !userName
          ? 'A userName is required.'
          : true;

      if (valid !== true) {
        /* istanbul ignore next */
        return reject({ error: true, message: valid, httpStatus: 400 });
      }

      const userObject = {
        cn: commonName,
        givenName: firstName,
        sn: lastName,
        mail: email,
        uid: userName,
        title: title,
        telephone: phone,
        userPrincipalName: `${userName}@${this.config.domain}`,
        sAMAccountName: userName,
        objectClass: this.config.defaults.userObjectClass,
        userPassword: ssha.create(pass)
      };

      this._addObject(`CN=${commonName}`, location, userObject)
        .then(res => {
          delete this._cache.users[userName];
          this._cache.all = {};
          return this.setUserPassword(userName, pass);
        })
        .then(data => {
          let expirationMethod =
            passwordExpires === false
              ? 'setUserPasswordNeverExpires'
              : 'enableUser';
          return this[expirationMethod](userName);
        })
        .then(data => {
          let enableMethod = enabled === false ? 'disableUser' : 'enableUser';
          return this[enableMethod](userName);
        })
        .then(data => {
          delete userObject.userPassword;
          return resolve(userObject);
        })
        .catch(err => {
          /* istanbul ignore next */
          const ENTRY_EXISTS = String(err.message).indexOf('ENTRY_EXISTS') > -1;
          /* istanbul ignore next */
          if (ENTRY_EXISTS) {
            /* istanbul ignore next */
            return reject({
              message: `User ${userName} already exists.`,
              httpStatus: 400
            });
          }
          /* istanbul ignore next */
          return reject({
            message: `Error creating user: ${err.message}`,
            httpStatus: 503
          });
        });
    });
  },

  updateUser(userName, opts) {
    return new Promise((resolve, reject) => {
      const domain = this.config.domain;
      const map = {
        firstName: 'givenName',
        lastName: 'sn',
        password: 'unicodePwd',
        commonName: 'cn',
        email: 'mail',
        title: 'title',
        objectClass: 'objectClass',
        userName: 'sAMAccountName'
      };

      let later = [];
      let operations = [];
      for (const name in opts) {
        //if (map[name] !== undefined ) {
          let key = map[name] || name;
          let value =
            name === 'password' ? encodePassword(opts[name]) : opts[name];
          if (key !== 'cn') {
            if (key === 'sAMAccountName') {
              later.push({
                sAMAccountName: value
              });
              later.push({
                uid: value
              });
              later.push({
                userPrincipalName: `${value}@${domain}`
              });
            } else {
              operations.push({
                [key]: value
              });
            }
          }
        //}
      }

      operations = operations.concat(later);
      let currUserName = userName;
      const go = () => {
        if (operations.length < 1) {
          delete this._cache.users[currUserName];
          delete this._cache.users[userName];
          resolve();
          return;
        }
        let next = operations.pop();
        this.setUserProperty(currUserName, next)
          .then(res => {
            if (next.userPrincipalName !== undefined) {
              currUserName = next.userPrincipalName;
            }
            delete this._cache.users[currUserName];
            go();
          })
          .catch(err => {
            return reject(err);
          });
      };

      this.findUser(currUserName)
        .then(data => {
          if (opts.commonName !== undefined) {
            return this.setUserCN(currUserName, opts.commonName);
          }
        })
        .then(data => {
          let expirationMethod =
            opts.passwordExpires === false
              ? 'setUserPasswordNeverExpires'
              : 'enableUser';
          if (opts.passwordExpires !== undefined) {
            return this[expirationMethod](userName);
          }
        })
        .then(data => {
          let enableMethod =
            opts.enabled === false ? 'disableUser' : 'enableUser';
          if (opts.enabled !== undefined) {
            return this[enableMethod](userName);
          }
        })
        .then(res => {
          go();
        })
        .catch(err => {
          return reject(err);
        });
    });
  },

  findUser(userName, opts) {
    userName = String(userName || '');
    return new Promise((resolve, reject) => {
      let cached = this._cache.get('users', userName);
      if (cached) {
        return resolve(api.processResults(opts, [cached])[0]);
      }
      const domain = this.config.domain;
      userName = userName.indexOf('@') > -1 ? userName.split('@')[0] : userName;
      const filter = `(|(userPrincipalName=${userName}@${domain})(sAMAccountName=${userName}))`;
      const params = {
        filter,
        includeMembership: ['all'],
        includeDeleted: false,
        attributes: ['*']
      };
      if (opts) {
        params.attributes = [...params.attributes, ...opts.fields];
      }
      this.ad.find(params, (err, results) => {
        if (err) {
          /* istanbul ignore next */
          return reject(err);
        }
        if (!results || !results.users || results.users.length < 1) {
          this._cache.set('users', userName, {});
          return resolve({});
        }
        this._cache.set('users', userName, results.users[0]);
        results.users = api.processResults(opts, results.users);
        return resolve(results.users[0]);
      });
    });
  },

  userExists(userName) {
    return new Promise((resolve, reject) => {
      const domain = this.config.domain;
      let fullUser = `${userName}@${domain}`;
      this.ad.userExists(fullUser, (error, exists) => {
        if (error) {
          /* istanbul ignore next */
          return reject(error);
        }
        return resolve(exists);
      });
    });
  },

  userIsMemberOf(userName, groupName) {
    return new Promise((resolve, reject) => {
      let userDN;
      this.findUser(userName)
        .then(userObject => {
          userDN = userObject.dn;
          return this._getGroupUsers(groupName);
        })
        .then(users => {
          users = users.filter(u => u.dn === userDN);
          let exists = users.length > 0;
          resolve(exists);
        })
        .catch(err => {
          /* istanbul ignore next */
          reject(err);
        });
    });
  },

  authenticateUser(userName, pass) {
    const domain = this.config.domain;
    let fullUser = `${userName}@${domain}`;
    return new Promise((resolve, reject) => {
      this.ad.authenticate(fullUser, pass, (error, authorized) => {
        let code;
        let out = authorized;
        if (error && error.lde_message) {
          out.detail = error.lde_message;
          out.message = String(error.stack).split(':')[0];
          error = undefined;
        }
        if (error) {
          /* istanbul ignore next */
          return reject(error);
        }
        return resolve(out);
      });
    });
  },

  setUserPassword(userName, pass) {
    return new Promise((resolve, reject) => {
      if (!pass) {
        return reject({ message: 'No password provided.' });
      }
      this._userReplaceOperation(userName, {
        unicodePwd: encodePassword(pass)
      })
        .then(resolve)
        .catch(reject);
    });
  },

  setUserCN(userName, cn) {
    return new Promise((resolve, reject) => {
      this.findUser(userName)
        .then(userObject => {
          let oldDN = userObject.dn;
          let parts = String(oldDN).split(',');
          parts.shift();
          parts.unshift(`CN=${cn}`);
          return this._modifyDN(oldDN, parts.join(','));
        })
        .then(result => {
          delete this._cache.users[userName];
          resolve(result);
        })
        .catch(err => {
          /* istanbul ignore next */
          reject(err);
        });
    });
  },

  setUserProperty(userName, obj) {
    return this._userReplaceOperation(userName, obj);
  },

  setUserPasswordNeverExpires(userName) {
    const NEVER_EXPIRES = 66048;
    return this._userReplaceOperation(userName, {
      userAccountControl: NEVER_EXPIRES
    });
  },

  enableUser(userName) {
    const ENABLED = 512;
    return this._userReplaceOperation(userName, {
      userAccountControl: ENABLED
    });
  },

  disableUser(userName) {
    const DISABLED = 514;
    return this._userReplaceOperation(userName, {
      userAccountControl: DISABLED
    });
  },

  moveUser(userName, location) {
    return new Promise((resolve, reject) => {
      location = parseLocation(location);
      this.findUser(userName)
        .then(userObject => {
          let oldDN = userObject.dn;
          let baseDN = String(this.config.baseDN).replace(/dc=/g, 'DC=');
          let newDN = `CN=${userObject.cn},${location}${baseDN}`;
          return this._modifyDN(oldDN, newDN);
        })
        .then(result => {
          delete this._cache.users[userName];
          resolve(result);
        })
        .catch(err => {
          /* istanbul ignore next */
          reject(err);
        });
    });
  },

  getUserLocation(userName) {
    return new Promise((resolve, reject) => {
      this.findUser(userName)
        .then(userObject => {
          if (Object.keys(userObject).length < 1) {
            /* istanbul ignore next */
            return reject({ error: true, message: 'User does not exist.' });
          }
          let dn = userObject.dn;
          let left = String(dn)
            .replace(/DC=/g, 'dc=')
            .replace(/CN=/g, 'cn=')
            .replace(/OU=/g, 'ou=')
            .split(',dc=')[0];
          let location = String(left)
            .split(',')
            .slice(1)
            .reverse()
            .join('/')
            .replace(/cn=/g, '!')
            .replace(/ou=/g, '');
          return resolve(location);
        })
        .catch(err => {
          /* istanbul ignore next */
          return reject(err);
        });
    });
  },

  unlockUser(userName) {
    return this._userReplaceOperation(userName, {
      lockoutTime: 0
    });
  },

  removeUser(userName) {
    return new Promise((resolve, reject) => {
      this.findUser(userName).then(userObject => {
        if (Object.keys(userObject).length < 1) {
          return reject({ error: true, message: 'User does not exist.' });
        }
        this._deleteObjectByDN(userObject.dn)
          .then(resp => {
            resolve(resp);
          })
          .catch(err => {
            /* istanbul ignore next */
            reject(Object.assign(err, { error: true }));
          });
      });
    });
  }
};
