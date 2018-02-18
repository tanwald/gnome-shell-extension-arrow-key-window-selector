/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Lang = imports.lang;
const Mainloop = imports.mainloop;

/*
 * Helper-class which applies patches to the GNOME Shell, remembers them
 * and can be used to remove effective patches when the extension gets 
 * disabled.
 */
function ExtHelper() {
    let _eventIds = {};
    let _timeoutIds = [];
    let _prototypes = [];
    let _idGen = 0;
    
    /*
     * Helper function for injecting code into existing functions. It stores
     * the original function for being able to undo the modification. If the
     * function does not exist, a new member will be added.
     * @param parent: Parent class.
     * @param name: Name of the function.
     * @param injectFunction: Function which is to be injected.
     * @param injectBefore: If true, code will be injected before the
     * existing code is applied.
     * @return: Return-value of the original or injected function.
     */
    let _inject = function(parent, name, injectFunction, injectBefore) {
        let prototype = parent.prototype[name];
        _prototypes.push([parent.prototype, name, prototype]);
        parent.prototype[name] = function() {
            let newReturnVal;
            if (injectBefore) {
                newReturnVal = injectFunction.apply(this, arguments); 
            }
            let returnVal;
            if (prototype !== undefined) {
                returnVal = prototype.apply(this, arguments); 
            }
            if (!injectBefore) {
                newReturnVal = injectFunction.apply(this, arguments); 
            } 
            if (newReturnVal !== undefined) {
                if (prototype !== undefined) {
                    log('WARNING: The injection into "' + name + '" of "' + 
                        parent +'" overrides or introduces a return value!');
                }
                returnVal = newReturnVal;
            }
            return returnVal;
        }; 
    };
    
    /*
     * Connects to signals of ClutterActors and stores the event-IDs, as well
     * as the emitter for later removal.
     * @param emitter: The emitter of the signal of interest.
     * @param signal: The signal of interest.
     * @param callback: The callback function which is to be called when the 
     * signal of interest is emitted. 
     * @return: Internal ID of the listener. Not the signal-ID for the emitter!
     */
    this.connect = function(emitter, signal, callback) {
        _eventIds[++_idGen] = [emitter, emitter.connect(signal, callback)];
        return _idGen;
    };
    
    /*
     * Convenience function which is useful when different signals should
     * call the same callback. See connect!
     * @param emitter: The emitter of the signals of interest.
     * @param signals: The signals of interest.
     * @param callback: The callback function which is to be called when the 
     * signals of interest are emitted. 
     * @return: Internal [IDs] of the listeners. 
     * Not the signal-ID for the emitter!
     */
    this.connectMulti = function(emitter, signals, callback) {
        let ids = [];
        signals.forEach(Lang.bind(this, function(signal) {
            ids.push(this.connect(emitter, signal, callback));
        }))
        return ids;
    };
    
    /*
     * Disconnects listeners from the emitters.
     * @param eventIds: The internal [event-IDs] of the listeners.
     */
    this.disconnect = function(eventIds) {
        eventIds.forEach(function(id) {
            // Ids got converted to strings by using them as keys.
            id = parseInt(id);
            try {
                _eventIds[id][0].disconnect(_eventIds[id][1]); 
            } catch(exception) {
                // The emitter might be dead by now - RIP.
                log(exception.message); 
            };
            delete _eventIds[id];
        })
    };
    
    /*
     * Disconnect all listeners registered by the connect-function and 
     * resets the id generator.
     */
    this.disconnectAll = function() {
        this.disconnect(_eventIds.keys());
        _idGen = 0;
    };
    
    /*
     * Adds a timeout and stores the timeout-ID.
     * @param timeout: Time in milliseconds.
     * @param callback: Function which is called after timeout.
     * @return: The timeout-ID.
     */
    this.addTimeout = function(timeout, callback) {
        let timeoutId = Mainloop.timeout_add(timeout, callback);
        _timeoutIds.push(timeoutId);
        return timeoutId;
    };
    
    /*
     * Removes the timeout with the given timeout-ID
     * @param timoutIds: The [IDs] of the timeouts which are to be removed.
     */
    this.removeTimeouts = function(timeoutIds) {
        timeoutIds.forEach(function(id) {
            Mainloop.source_remove(
                _timeoutIds.splice(_timeoutIds.indexOf(timeoutIds[id]), 1)[0]
            );
        })
    };
    
    /*
     * Removes all timeouts.
     */
    this.removeAll = function() {
        this.removeTimeouts(_timeoutIds);
    };
    
    /*
     * Helper function for injecting code into functions before the 
     * existing code is called.
     * @param parent: Parent class.
     * @param name: Name of the function.
     * @param injectFunction: Function which is to be injected.
     * @return: Return-value of the original or injected function.
     */
    this.injectBefore = function(parent, name, injectFunction) {
        return _inject(parent, name, injectFunction, true);
    };
    
    /*
     * Helper function for injecting code into functions after the 
     * existing code is called.
     * @param parent: Parent class.
     * @param name: Name of the function.
     * @param injectFunction: Function which is to be injected.
     * @return: Return-value of the original or injected function.
     */
    this.injectAfter = function(parent, name, injectFunction) {
        return _inject(parent, name, injectFunction, false);
    };
    
    /*
     * Adds a new member function to the given class.
     * @param parent: Parent class.
     * @param name: Name of the new member.
     * @param newMember: Member-function which is to be added.
     * @return: Return-value of the new member.
     */
    this.addMember = function(parent, name, newMember) {
        if (parent.prototype[name] !== undefined) {
            log('WARNING: Member "' + name + '" of "' + parent +
                '" already exists and will be overridden!');
        }
        return _inject(parent, name, newMember, false);
    };
    
    /*
     * Removes an injected function which has been stored by one of the 
     * injection-functions and restores the original prototype.
     * @param parent: The object where an injected function should be removed.
     * @param name: The name of the injected (or added) function.
     * @param prototype: The original function. 
     */
    this.removeInjection = function(parent, name, prototype) {
        if (prototype === undefined) {
            delete parent[name];
        } else {
            parent[name] = prototype; 
        }
    };
    
    /*
     * Removes all effective patches from the GNOME Shell which were introduced
     * by the extension. Ineffective orphans will be removed on restart of 
     * the GNOME Shell.  
     */
    this.cleanUp = function() {
        this.disconnectAll();
        this.removeAll();
        _prototypes.forEach(Lang.bind(this, function(prototype) {
            this.removeInjection(prototype[0], prototype[1], prototype[2]);
        }))
    };
}