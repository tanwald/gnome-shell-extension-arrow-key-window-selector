/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const Tweener = imports.ui.tweener;
const ViewSelector = imports.ui.viewSelector;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

/*
 * Helper-class which applies patches to the GNOME Shell, remembers them
 * and can be used to remove effective patches when the extension gets 
 * disabled.
 */
function ExtHelper() {
    var _eventIds = {};
    var _timeoutIds = [];
    var _prototypes = [];
    var _idGen = 0;
    
    // Constants that affect the behavior of the extension. 
    this.settings = {
        MOTION_THRESHOLD: 5,
        PADDING: 30,
        ZOOM_FACTOR: 1.5,
        FOCUS_TIME: 0.15,
        MEMORY: true
    };
    
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
    var _inject = function(parent, name, injectFunction, injectBefore) {
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
     * @param signals: The signal of interest.
     * @param callback: The callback function which is to be called when the 
     * signals of interest is emitted. 
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
     * Disconnects listeners from their emitters.
     * @param eventIds: The [event-IDs] of the listeners.
     */
    this.disconnect = function(eventIds) {
        eventIds.forEach(function(id) {
            id = parseInt(id);
            _eventIds[id][0].disconnect(_eventIds[id][1]); 
            delete _eventIds[id];
        })
    };
    
    /*
     * Disconnect all listeners registered by the connect-function and 
     * resets the id generator.
     */
    this.disconnectAll = function() {
        this.disconnect([i for (i in _eventIds)]);
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
        this.removeTimeouts([_timeoutIds[i] for (i in _timeoutIds)]);
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
     * injection-functions.
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
var ext = new ExtHelper();

/*
 * Class for enhanced keyboard navigation in overview mode.
 * @param workspacesDisplay: Reference to the WorkspacesDisplay. 
 * @param settings: Object containing constants.
 */
function KeyCtrl(workspacesDisplay, settings) {
    log("INIT");
    // Index of the window that is - or is to be - selected.
    var _arrowKeyIndex = 0;
    var _initialIndex = 0;
    // Navigation memory for making every navigation-step reversible. 
    // Otherwise you could navigate into one direction
    // and the next move into the opposite direction would not bring
    // you back to the origin if there was a closer
    // window in that direction. As a side effect navigation 
    // rules are cached.
    var _navMemory = [];
    var _navMemoryActive = settings.MEMORY;
    var _workspacesDisplay = workspacesDisplay;
    var _workspacesViews = workspacesDisplay._workspacesViews;
    var _viewsAgent = _workspacesViews[0];
    // Window overlays of the overview.
    var _windowOverlays = [];
    // Number of before mentioned windows which have already arrived
    // their final position within the overview.
    var _windowReadyCount = 0;
    var _lightbox = null;
    // The currently selected window. Actually it's the window overlay 
    // because it contains the most information and has access to other 
    // abstractions.
    var _selected = null;
    var _active = null;
    // Flag to indicate if a window selection took place.
    var _selecting = false;
    // Flags to indicate events or changes in the overview.
    var _upToDate = false;
    var _blocked = false;
    var _inDrag = false;
    // Storage for pointer-movement data. Defined in _startSelection.
    var _deltaMotion;
    // Declaration of listener-IDs.
    var _transientEventIds = [];
    var _selectionEventIds = [];
    var _windowReadyEventIds = [];
    
    /*
     * Registers listeners at construction time and whenever the active 
     * workspace changes.
     */
    var _registerTransientListeners = Lang.bind(this, function() {
        log('transient');
        // Blocks KeyCtrl while windows are - or are about to - change their
        // positions.
        _transientEventIds.push(ext.connect(
            _viewsAgent.getActiveWorkspace(),
            'window-positioning-init',
            function() {
                _blocked = true; 
            }
        ));
        // Detects when the window-animation starts, triggers an update 
        // after the animation has ended and removes the block of KeyCtrl.
        _transientEventIds.push(ext.connect(
            _viewsAgent.getActiveWorkspace(),
            'window-positioning-start',
            Lang.bind(this, function() {
                this.onWindowPositioningStart(); 
            })
        )); 
    });
    _registerTransientListeners();
    
    /*
     * Registers all listeners at construction time of the KeyCtrl-class.
     */
    var _registerPermanentListeners = Lang.bind(this, function() {
         // Listener for key-press-events. This is where KeyCtrl comes to life.
        ext.connect(
            global.stage,
            'key-press-event',
            Lang.bind(this, function(actor, event) {
                log('key');
                this.onKeyPress(event);
            })
        );
        // Listeners for windows arriving at their final position during
        // "zooming-in" of the overview.
        _workspacesViews.forEach(Lang.bind(this, function(view) {
            _windowReadyEventIds.push(ext.connect(
                view.getActiveWorkspace(),
                'window-ready',
                Lang.bind(this, function() {
                    this.onWindowReady();
                })
            ))
        }))
        // Updates the stored overview-state when windows enter or leave the
        // monitor. It is also called when windows are added or removed from
        // a workspace.
        ext.connectMulti(
            global.screen,
            ['window-entered-monitor', 'window-left-monitor'],
            Lang.bind(this,function() {
                log('entered or left or removed or added');
                _upToDate = false;
                this.updateOverviewState();
            })
        );
        // Blocks KeyCtrl while windows are dragged.
        ext.connect(
            Main.overview,
            'window-drag-begin',
            function() {
                _blocked = true;
                _inDrag = true;
            }
        );
        // Removes the block of KeyCtrl when dragging has ended.
        ext.connect(
            Main.overview,
            'window-drag-end',
            function() {
                _blocked = false;
                _inDrag = false;
            }
        );
        // Listener for getting the state of the just activated workspace.
        ext.connect(
            _viewsAgent,
            'workspace-switched',
            Lang.bind(this, function() {
                log('workspace switched');
                ext.disconnect(_transientEventIds);
                _transientEventIds = [];
                _registerTransientListeners();
                this.updateOverviewState();
            })
        );
        // Listener for cleanup before the hiding-animation starts.
        ext.connect(
            Main.overview,
            'hiding-start',
            Lang.bind(this, function() {
                this.onOverviewHiding();
            })
        );
    });
    _registerPermanentListeners();
    
    /*
     * Calculates the Manhattan-Distance of two points in a 
     * 2D coordinate system. 
     * @param x1, x2: x-coordinates of the two points.
     * @param y1, y2: y-coordinates of the two points.
     * @return: Number
     */
    var _calcManhattanDistance = function(x1, x2, y1, y2) {
        return Math.abs(x1 - x2) + Math.abs(y1 - y2);
    };
    
    /*
     * Calculates the Manhattan-Distance of two windows in overview mode. 
     * @param sw: Selected window.
     * @param cw: Currently evaluated window.
     * @return: Number
     */
    var _calcWindowDistance = function(sw, cw) {
        return _calcManhattanDistance(
                   sw.center_x, cw.center_x, 
                   sw.center_y, cw.center_y
               );
    };
    
    /*
     * Decides if the movement of the pointer exceeds a certain threshold.
     * Otherwise a slight vibration of the table would stop the selection.
     */
    var _isMotion = function(event) {
        let coords = event.get_coords();
        let delta = _calcManhattanDistance(
            _deltaMotion[0], coords[0],
            _deltaMotion[1], coords[1]
        );
        _deltaMotion = coords;
        return delta > settings.MOTION_THRESHOLD;
    }
    
    /*
     * Subroutine for workspacesView._updateArrowKeyIndex. It finds the closest
     * window in the given direction and is therefore independent of window-
     * positioning-strategies.
     * @param key: Pressed key.
     * @param reverseKey: Key for reverse navigation.
     * @param conditionCb: Callback which decides whether the current window in
     * a loop is closer in the defined direction than the previous one. 
     */
    var _updateArrowKeyIndexSub = function(key, reverseKey, conditionCb) {
        let currArrowKeyIndex = _arrowKeyIndex;
        if(_navMemoryActive && _navMemory[_arrowKeyIndex][key] !== undefined) {
            // Retrieve navigation rule.
            _arrowKeyIndex = _navMemory[_arrowKeyIndex][key];
        } else {
            // Find closest window in that direction.
            // sw ... selected window.
            // cw ... current window.
            let sw = _selected.getStoredGeometry();
            // Just in case some user has infinite resolution...
            let minDistance = Number.POSITIVE_INFINITY;
            for (var i = 0; i < _windowOverlays.length; i++) {
                let cw = _windowOverlays[i].getStoredGeometry();
                let distance = _calcWindowDistance(sw, cw);
                if (conditionCb(sw, cw, distance, minDistance)) {
                    _arrowKeyIndex = i;
                    minDistance = distance;
                }
            } 
        }
        // Store reverse navigation rules.
        if (_navMemoryActive && _arrowKeyIndex != currArrowKeyIndex) {
            _navMemory[_arrowKeyIndex][reverseKey] = currArrowKeyIndex;
            _navMemory[currArrowKeyIndex][key] = _arrowKeyIndex;
        }
    };
    
    /*
     * Contains all the logic for selecting a new window based on arrow key 
     * input.
     * @param key: Pressed key.
     */
    var _updateArrowKeyIndex = function(key) {
        // Move up.
        if (key == Clutter.Up) {
            _updateArrowKeyIndexSub(
                key,
                Clutter.Down,
                function(sw, cw, distance, minDistance) {
                    return cw.y + cw.height < sw.y && distance < minDistance;
                }
            );           
        // Move down.
        } else if (key == Clutter.Down) {
            _updateArrowKeyIndexSub(
                key,
                Clutter.Up,
                function(sw, cw, distance, minDistance) {
                    return cw.y > sw.y + sw.height && distance < minDistance;
                }
            );
        // Move left.
        } else if (key == Clutter.Left) {
            _updateArrowKeyIndexSub(
                key,
                Clutter.Right,
                function(sw, cw, distance, minDistance) {
                    return cw.x + cw.width < sw.x && distance < minDistance;
                }
            );
        // Move right.
        } else if (key == Clutter.Right) {
            _updateArrowKeyIndexSub(
                key,
                Clutter.Left,
                function(sw, cw, distance, minDistance) {
                    return cw.x > sw.x + sw.width && distance < minDistance;
                }
            );
        }
    };
    
    /*
     * Get the current state of the overview and prepare members for the 
     * selection process.
     */
    var _updateOverviewState = function() {
        log('updated.' + _upToDate);
        _windowOverlays = _workspacesDisplay.getWindowOverlays(_upToDate);
        log(_windowOverlays.length);
        _upToDate = true;
        let focus = global.screen.get_display().focus_window;
        let focusFound = false;
        _windowOverlays.forEach(function(windowOverlay, index) {
            windowOverlay.setFocus(false);
            // Store initial geometry.
            windowOverlay.getWindowClone().createGeometrySnapshot();
            // Initialize a navigation memory for each window overlay.
            _navMemory[index] = {};
            // Find window which has focus. If no window has focus select 
            // the last window in the list - for example on GNOME Shell restart.
            if (windowOverlay.getMetaWindow() == focus ||
                (!focusFound && index == _windowOverlays.length - 1)) {
                _arrowKeyIndex = index;
                _selected = windowOverlay;
                _active = _selected;
                _active.setFocus(true);
                focusFound = true;
            }
        })
    };
    
    /*
     * Tidy up all actors and adjustments that were introduced during the
     * selection process.
     * @param resetG: Flag which indicates if the geometry of the focused
     * window should be reset.
     * @param resetKeyCtrl: Resets the stored state of the overview. 
     */
    var _endSelection = function(resetG, resetKeyCtrl) {
        if (_selecting) {
            _selected.unselect(resetG);
            _lightbox.hide();
            ext.disconnect(_selectionEventIds);
            _selectionEventIds = [];
        }
        if (resetKeyCtrl) {
            _arrowKeyIndex = 0;
            _windowOverlays = [];
            _navMemory = [];
            _selected = null;
            if (_active) {
                _active.setFocus(false);
                _active = null;
            }
            if (_lightbox) {
                _lightbox.destroy();
                _lightbox = null
            }
            _upToDate = false;
        } else {
            // Overview state has not changed.
            _selected = _active;
            _active.setFocus(true);
            _arrowKeyIndex = _initialIndex;
        }
        _selecting = false;
    };
    
    /*
     * Starts the selection process and registers listeners which should
     * stop the process.
     */
    var _startSelection = function() {
        _lightbox = new Lightbox.Lightbox(Main.layoutManager.overviewGroup);
        _lightbox.show();
        _deltaMotion = global.get_pointer();
        _initialIndex = _arrowKeyIndex;
        _selecting = true;
        // Mouse events stop the keyboard selection.
        _selectionEventIds.push(ext.connect(
            global.stage,
            'button-press-event', 
            Lang.bind(this, function() {
                _endSelection(true, true);
            })
        ));
        _selectionEventIds.push(ext.connect(
            global.stage,
            'motion-event', 
            Lang.bind(this, function(actor, event) {
                if (_isMotion(event)) {
                    _endSelection(true, false);
                }
            })
        ));
    };
    
    /*
     * Selects and highlights windows based on arrow key input.
     * @param key: Pressed arrow key.
     * @param first: The first navigation could be in a wrong direction
     * but we still want to highlight the active window.
     */
    var _select = function(key, first) {
        let currArrowKeyIndex = _arrowKeyIndex;
        // Find the index of the window that is to be selected based 
        // on the keyboard input. The result is saved in the member
        // _arrowKeyIndex.
        _updateArrowKeyIndex(key);
        // Select and highlight the window if the navigation was valid.
        if (_arrowKeyIndex != currArrowKeyIndex) {
            // First unselect the previous selection.
            _selected.unselect(true);
            _selected = _windowOverlays[_arrowKeyIndex];
            // Highlight.
            _selected.select(_lightbox);
        } else if (first) {
            _selected.select(_lightbox);
        }
    };
    
    /*
     * Checks if everything is ready for the selection process to start.
     * @return: boolean
     */
    var _canSelect = function() {
        return _windowOverlays.length > 0 && 
               !_blocked && 
               Main.overview.viewSelector.getActivePage() == 
               ViewSelector.ViewPage.WINDOWS;
    };
    
    /*
     * Checks what to do when an arrow key was pressed and calls the appropriate
     * methods.
     * @param key: Pressed arrow key.
     */
    var _onArrowKeyPress = function(key) {
        if (_canSelect()) {
            let first = false;
            if (!_selecting) {
                _startSelection();
                first = true;
            }
            _select(key, first);
        } 
    };
    
    /*
     * Switches the active workspace when defined keys are pressed.
     * @param key: switch-defining keyboard key.
     */
    var _onPageKeyPress = function(key) {
        let activeIndex = global.screen.get_active_workspace_index();
        if (key == Clutter.Page_Down) {
            activeIndex += 1;
        } else if (key == Clutter.Page_Up) {
            activeIndex -= 1;
        // First workspace.
        } else if (key == Clutter.Home) {
            activeIndex = 0;
        // Last workspace.
        } else if (key == Clutter.End) {
            activeIndex = global.screen.get_n_workspaces() - 1;
        }
        _endSelection(true, true);
        if (activeIndex < global.screen.get_n_workspaces() && 
            activeIndex >= 0) {
            global.screen.get_workspace_by_index(activeIndex).activate(true);
        }
    };
    
    /*
     * Moves the selected window to the workspace with the number of the
     * function key i.e. F1 -> workspace 1.
     * @param key: function key identifier.
     */
    var _onFunctionKeyPress = function(key) {
        // F1 means workspace 1 which is at index 0.
        let workspaceIndex = key - Clutter.F1;
        if (_selected && workspaceIndex < global.screen.get_n_workspaces()) {
            let window = _selected.getMetaWindow();
            window.change_workspace_by_index(
                workspaceIndex, 
                false, 
                global.get_current_time()
            );
            _endSelection(false, true);
        }
    };
    
    /*
     * Closes the currently selected window when the delete key is pressed.
     */
    var _onDeleteKeyPress = function() {
        _windowOverlays[_arrowKeyIndex].closeWindow();
        _endSelection(false, true);
    };
    
    /*
     * Activates the currently selected window when the return key is pressed.
     */
    var _onReturnKeyPress = function() {
        let metaWindow = _windowOverlays[_arrowKeyIndex].getMetaWindow();
        if (_selecting) {
            _endSelection(false, true); 
        }
        Main.activateWindow(metaWindow, global.get_current_time());
    };
    
    /*
     * Called when the active workspace starts to reposition its windows.
     */
    this.onWindowPositioningStart = function() {
        // Not on overview start and when windows are dragged.
        if (_windowReadyEventIds.length == 0 && !_inDrag) {
            _upToDate = false;
            ext.addTimeout(
                // Overview animation time is defined in seconds... 
                Overview.ANIMATION_TIME * 1000 * 2,
                Lang.bind(this, function() {
                    _blocked = false;
                    this.updateOverviewState();
                })
            ); 
        }
    };
    
    /*
     * Detects when all windows are at their final position within the 
     * overview and gets the state of the active workspace. 
     */
    this.onWindowReady = function() {
        _windowReadyCount += 1;
        if (_windowReadyCount == _workspacesDisplay.getWindowCount(_upToDate)) {
            // Only applied when the overview is initially shown (to be quick).
            ext.disconnect(_windowReadyEventIds);
            _windowReadyEventIds = [];
            this.updateOverviewState();
        }
        _upToDate = true;
    };
    
    /*
     * Updates the state of the active workspace.
     */
    this.updateOverviewState = function() {
        if (!_blocked && !_selecting) {
            _updateOverviewState();
        }
    };
    
    /*
     * Ends the current selection process when the overview starts hiding.
     */
    this.onOverviewHiding = function() {
        _endSelection(false, true);
    };
    
    /*
     * Callback function that is triggered by 'key-press-events' and delegates 
     * to the according subroutines.
     * @param event: The event object. 
     */
    this.onKeyPress = function(event) {
        let key = event.get_key_symbol();
        log(key);
        // Select and highlight windows in overview-mode.
        if (key == Clutter.Up || key == Clutter.Down || 
            key == Clutter.Left || key == Clutter.Right) {
            _onArrowKeyPress(key);
        // Switch workspace
        } else if (key == Clutter.Page_Down || key == Clutter.Page_Up || 
                   key ==Clutter.Home || key ==Clutter.End) {
            _onPageKeyPress(key);
         // Move window when F1-F12 is pressed
        } else if(key >= Clutter.F1 && key <= Clutter.F12) {
            _onFunctionKeyPress(key);
        // Close window when del is pressed.
        } else if (key == Clutter.Delete) {
            _onDeleteKeyPress();
        // Activate the selected window when return is pressed.
        } else if (key == Clutter.Return) {
            _onReturnKeyPress();
        } else if (_selecting) {
            _endSelection(true, false);
        } 
    };
    
    /*
     * Disconnects all listeners and removes all timeouts. Thalamus shuts down.
     */
    this.sleep = function() {
        _endSelection(false, true);
        ext.disconnectAll();
        ext.removeAll();
    };
}

function enable() {

////////////////////////////////////////////////////////////////////////////////
// Overview ////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * In contrast to 'hiding', this really indicates the start of the hiding
     * process of the overview.
     */
    ext.injectBefore(
        Overview.Overview,
        'hide',
        function() {
            this.emit('hiding-start');
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// WorkspacesDisplay ///////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Here we go...
     */
    ext.injectAfter(
        WorkspacesView.WorkspacesDisplay, 
        'show', 
        function() {
            log("SHOW");
            // Kind of cache for all selectable windows.
            this._windowOverlaysActive = [];
            this._keyCtrl = new KeyCtrl(this, ext.settings);
        }
    );
    
    /*
     * Here we leave...
     */
    ext.injectAfter(
        WorkspacesView.WorkspacesDisplay, 
        'hide', 
        function() {
            log("HIDE");
            this._windowOverlaysActive = [];
            this._keyCtrl.sleep();
        }
    );
    
    /*
     * Getter for window overlays of the active workspace and surrounding
     * extra workspaces on different monitors.
     * @return: [ WindowOverlay ]
     */
     ext.addMember(
         WorkspacesView.WorkspacesDisplay,
         'getWindowOverlays',
         function(upToDate) {
             let windowOverlays = [];
             if (upToDate) {
                 // Retrieve from "cache".
                 windowOverlays = this._windowOverlaysActive;
             } else {
                 this._workspacesViews.forEach(function(view) {
                     windowOverlays.push.apply(
                         windowOverlays,
                         view.getWindowOverlays()
                     );
                 })
                 this._windowOverlaysActive = windowOverlays;
             }
             return windowOverlays;
          }
      );
     
     /*
      * Returns the number of managed windows of the active workspace. 
      * @return: Number
      */
     ext.addMember(
         WorkspacesView.WorkspacesDisplay,
         'getWindowCount',
         function(upToDate) {
             return this.getWindowOverlays(upToDate).length;
         }
     );
 
////////////////////////////////////////////////////////////////////////////////
// WorkspacesView //////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
    * Getter for window overlays of the active workspace.
    * @return: [ WindowOverlay ]
    */
    ext.addMember(
        WorkspacesView.WorkspacesView,
        'getWindowOverlays',
        function() {
            return this.getActiveWorkspace().getWindowOverlays();
        }
    );
    
    ext.injectAfter(
        WorkspacesView.WorkspacesView, 
        '_updateScrollAdjustment', 
        function() {
            ext.addTimeout(
                // Animation time is defined in seconds... 
                WorkspacesView.WORKSPACE_SWITCH_TIME * 1000 * 2,
                Lang.bind(this, function() {
                    this.emit('workspace-switched');
                })
            );
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// Workspace ///////////////////////////////////////////////////////////////////   
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Getter for window overlays of a workspace. 
     * @return: [ WindowOverlay ]
     */
    ext.addMember(
        Workspace.Workspace,
        'getWindowOverlays',
        function() {
            return this._windowOverlays.slice();
        }
    );
    
    /*
     * Emits a signal when the workspace starts the animation of the window-
     * repositioning.
     */
    ext.injectAfter(
        Workspace.Workspace, 
        '_updateWindowPositions', 
        function() {
            this.emit('window-positioning-start');
        }
    );
    
    /*
     * Emits a signal when the workspace prepares the animation of the window-
     * repositioning.
     */
    ext.injectBefore(
        Workspace.Workspace, 
        '_delayedWindowRepositioning', 
        function() {
            this.emit('window-positioning-init');
        }
    );
    
    /*
     * Emits a signal when the window-overlay of a window is shown and therefore
     * indicates the end of its animation.
     */
    ext.injectAfter(
        Workspace.Workspace, 
        '_showWindowOverlay', 
        function() {
            this.emit('window-ready');
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// WindowClone /////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Introduces a dictionary for window geometry and sets _origParent to null
     * for easier checks if it is set.
     */
    ext.injectAfter(
        Workspace.WindowClone, 
        '_init', 
        function(realWindow) {
            this.storedGeometry = {};
            this._origParent = null;
            this._origSibling = null;
        }
    );
    
    /*
     * Highlights and zooms the currently selected window.
     * @param lightbox: A reference to the lightbox introduced by 
     * _startSelection.
     */
    ext.addMember(
        Workspace.WindowClone,
        'select',
        function(lightbox) {
            let actor = this.actor;
            // Store the initial geometry of the window.
            this.createGeometrySnapshot();
            // Store the original parent and highlight the window.
            this._origParent = actor.get_parent();
            this._origSibling = actor.get_previous_sibling();
            actor.raise_top();
            actor.reparent(Main.layoutManager.overviewGroup);
            lightbox.highlight(actor);
            // Define the available area.
            let monitorIndex = this.metaWindow.get_monitor();
            let availArea = Main.layoutManager.monitors[monitorIndex];
            let padding = ext.settings.PADDING;
            let limitTop = availArea.y + padding;
            let limitBottom = availArea.y + availArea.height - padding;
            let limitLeft = availArea.x + padding;
            let limitRight = availArea.x + availArea.width - padding;
            let limitWidth = limitRight - limitLeft;
            let limitHeight = limitBottom - limitTop;
            // Calculate the desired new dimension.
            let factor = ext.settings.ZOOM_FACTOR;
            let newScaleX = actor.scale_x * factor;
            let newScaleY = actor.scale_y * factor;
            let newWidth = actor.width * newScaleX;
            let newHeight = actor.height * newScaleY;
            // Adjust the dimension to the available area.
            while (newWidth > limitWidth || newHeight > limitHeight || 
                   newScaleX > 1.0 || newScaleY > 1.0) {
                factor -= 0.1;
                newScaleX = actor.scale_x * factor;
                newScaleY = actor.scale_y * factor;
                newWidth = actor.width * newScaleX;
                newHeight = actor.height * newScaleY;
            }
            // Calculate the desired new position.
            let deltaWidth =  newWidth - actor.width * actor.scale_x;
            let deltaHeight = newHeight - actor.height * actor.scale_y;
            let newX = actor.x - deltaWidth / 2;
            let newY = actor.y - deltaHeight / 2;
            // Adjust the new position to the available area.
            if (monitorIndex == Main.layoutManager.primaryIndex){
                limitTop += Main.panel.actor.height;
            }
            if (newX + newWidth > limitRight) newX = limitRight - newWidth;
            if (newX < limitLeft) newX = limitLeft;
            if (newY + newHeight > limitBottom) newY = limitBottom - newHeight;
            if (newY < limitTop) newY = limitTop;
            // Zoom the window.
            Tweener.addTween(actor, { 
                x: newX,
                y: newY,
                scale_x: newScaleX,
                scale_y: newScaleY,
                time: ext.settings.FOCUS_TIME,
                transition: 'easeOutQuad' 
             });
        }
    );
        
    /*
     * Reverts the adjustments done by WindowClone.select.
     * @param resetG: Flag which indicates if the geometry 
     * should be reset.
     */
    ext.addMember(
        Workspace.WindowClone,
        'unselect',
        function(resetG) {
            let actor = this.actor;
            if (resetG) {
                actor.x = this.storedGeometry.x; 
                actor.y = this.storedGeometry.y;
                actor.scale_x = this.storedGeometry.scale_x;
                actor.scale_y = this.storedGeometry.scale_y; 
            }
            if (this._origParent) {
                actor.reparent(this._origParent);
                if (this._origSibling) {
                    actor.raise(this._origSibling);
                } else {
                    actor.lower_bottom();
                }
                Tweener.removeTweens(actor);
            }
        }
    );
    
    /*
     * Creates a snapshot of the window geometry.
     */
    ext.addMember(
        Workspace.WindowClone,
        'createGeometrySnapshot',
        function() {
            let actor = this.actor;
            let width = actor.width * actor.scale_x;
            let height = actor.height * actor.scale_y;
            this.storedGeometry = {
                x: actor.x, 
                y: actor.y,
                width: width,
                height: height, 
                scale_x: actor.scale_x,
                scale_y: actor.scale_y,
                center_x: actor.x + width / 2,
                center_y: actor.y + height / 2
            };
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// WindowOverlay ///////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Adds a border - actually two - for indicating the last active window.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        '_init', 
        function(windowClone, parentActor) {
            this.activeBorderInner = new St.Bin(
                { style_class: 'active-window-clone-border-inner' }
            );
            this.activeBorderInner.hide();
            parentActor.add_actor(this.activeBorderInner);
            this.activeBorderInner.lower_bottom();
            this.activeBorderOuter = new St.Bin(
                { style_class: 'active-window-clone-border-outer' }
            );
            this.activeBorderOuter.hide();
            parentActor.add_actor(this.activeBorderOuter);
            this.activeBorderOuter.raise(this.activeBorderInner);
            this.isFocusWindow = false;
        }
    );
    
    /*
     * Destroys the previously added border (_init).
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        '_onDestroy', 
        function() {
            this.activeBorderInner.destroy();
            this.activeBorderOuter.destroy();
        }
    );
    
    /*
     * Includes the border when the overlay is shown.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        'show', 
        function() {
            if (this.isFocusWindow) {
                this.activeBorderInner.show();
                this.activeBorderOuter.show(); 
            }
        }
    );
    
    /*
     * Includes the border when the overlay is hided.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        'hide', 
        function() {
            this.activeBorderInner.hide();
            this.activeBorderOuter.hide(); 
        }
    );
    
    /*
     * Applies the border-style dependent on the size and position of the
     * window-clone it contains.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        'relayout', 
        function(animate) {
            let [cloneX, 
                 cloneY, 
                 cloneWidth, 
                 cloneHeight] = this._windowClone.slot;
            // Relayout inner border.
            let activeBorderInner = this.activeBorderInner;
            let borderNode = activeBorderInner.get_theme_node();
            let activeBorderSize = borderNode.get_border_width(St.Side.TOP);
            let borderX = cloneX - activeBorderSize;
            let borderY = cloneY - activeBorderSize;
            let borderWidth = cloneWidth + 2 * activeBorderSize;
            let borderHeight = cloneHeight + 2 * activeBorderSize;
            Tweener.removeTweens(activeBorderInner);
            if (animate) {
                this._animateOverlayActor(
                    activeBorderInner, 
                    borderX, 
                    borderY,
                    borderWidth, 
                    borderHeight
                );
            } else {
                activeBorderInner.set_position(borderX, borderY);
                activeBorderInner.set_size(borderWidth, borderHeight);
            }
            // Relayout outer border.
            let activeBorderOuter = this.activeBorderOuter;
            borderNode = activeBorderOuter.get_theme_node();
            activeBorderSize = borderNode.get_border_width(St.Side.TOP);
            borderX -= activeBorderSize;
            borderY -= activeBorderSize;
            borderWidth += 2 * activeBorderSize;
            borderHeight += 2 * activeBorderSize;
            Tweener.removeTweens(activeBorderOuter);
            if (animate) {
                this._animateOverlayActor(
                    activeBorderOuter, 
                    borderX, 
                    borderY,
                    borderWidth, 
                    borderHeight
                );
            } else {
                activeBorderOuter.set_position(borderX, borderY);
                activeBorderOuter.set_size(borderWidth, borderHeight);
            }
        }
    );
    
    /*
     * Selects the associated window. See WindowClone.select.
     * @param lightbox: A reference to the lightbox introduced by 
     * KeyCtrl's _startSelection.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'select',
        function(lightbox) {
            this.hide();
            this.setFocus(false);
            this._windowClone.select(lightbox);
        }
    );
    
    /*
     * Unselects the associated window. See WindowClone.unselect.
     * @param resetG: Flag which indicates if the geometry should be reset.
     * @param hideB: Flag which indicates if the boder of the active window
     * should be hided. 
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'unselect',
        function(resetG) {
            this.show();
            this.setFocus(false);
            this._windowClone.unselect(resetG);
        }
    );
    
    /*
     * Marks the last active window with a border or removes that border again.
     * @param set: Flag to indicate whether the window should be marked as 
     * focused/active or not.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'setFocus',
        function(set) {
            if (set) {
                this.activeBorderInner.show();
                this.activeBorderOuter.show();
            } else {
                this.activeBorderInner.hide();
                this.activeBorderOuter.hide();
            }
            this.isFocusWindow = set;
        }
    );
    
    /*
     * Closes the associated window.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'closeWindow',
        function() {
            this._closeWindow();
        }
    );
    
    /*
     * Returns a geometry-info object of the window clone.
     * @return: Object.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'getStoredGeometry',
        function() {
            return this._windowClone.storedGeometry;
        }
    );
    
    /*
     * Getter for the window clone.
     * @return: WindowClone.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'getWindowClone',
        function() {
            return this._windowClone;
        }
    );
    
    /*
     * Getter for the meta window.
     * @return: MetaWindow.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'getMetaWindow',
        function() {
            return this._windowClone.metaWindow;
        }
    );
    
    log('Arrow Key Window Selector enabled');
}
    
    
function disable() {
    ext.cleanUp();
    log('Arrow Key Window Selector disabled');
}
