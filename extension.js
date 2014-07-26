/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
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
    var _prototypes = [];
    
    // Constants that affect the behavior of the extension. 
    this.settings = {
        ZOOM_FACTOR: 1.3,
        FOCUS_TIME: 0.2,
        MEMORY: true
    };
    
    /*
     * Helper function for injecting code into existing functions. It stores
     * the original function for being able to undo the modification.
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
            let returnVal = prototype.apply(this, arguments);
            if (!injectBefore) {
                newReturnVal = injectFunction.apply(this, arguments); 
            } 
            if (newReturnVal !== undefined) {
                log('Warning: The injection into "' + name + '" of "' + parent +
                    '" overrides or introduces a return value!');
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
     */
    this.connect = function(emitter, signal, callback) {
        var eventId = emitter.connect(signal, callback);
        _eventIds[eventId] = emitter;
        return eventId;
    };
    
    /*
     * Disconnects a listener from an emitter.
     * @param eventId: The registration-ID of the listener.
     */
    this.disconnect = function(eventId) {
        _eventIds[eventId].disconnect(eventId);
        delete _eventIds[eventId];
    };
    
    /*
     * Disconnect all listeners registered by the connect-function.
     */
    this.disconnectAll = function() {
        for (var id in _eventIds) {
            this.disconnect(parseInt(id));
        }
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
        _inject(parent, name, injectFunction, true);
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
        _inject(parent, name, injectFunction, false);
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
        for (var i = 0; i < _prototypes.length; i++) {
            this.removeInjection(
                _prototypes[i][0], 
                _prototypes[i][1], 
                _prototypes[i][2]
            );
        }
    };
}
var ext = new ExtHelper();

/*
 * Class for enhanced keyboard navigation in overview mode.
 * @param workspacesView: Reference to the current workspacesView. 
 * @param settings: Object containing constants.
 */
function KeyCtrl(workspacesView, settings) {
    
    // Index of the window that is - or is to be - selected.
    var _arrowKeyIndex = 0;
    // Navigation memory for making every navigation-step reversible. 
    // Otherwise you could navigate into one direction
    // and the next move into the opposite direction would not bring
    // you back to the origin if there was a closer
    // window in that direction. As a side effect navigation 
    // rules are cached.
    var _navMemory = [];
    var _navMemoryActive = settings.MEMORY;
    var _workspacesView = workspacesView;
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
    // Flag to indicate if the stored state of the overview is up to date.
    var _upToDate = false;
    var _overviewReady = false;
    // Declaration of listener-IDs.
    var _buttonPressEventId = -1;
    var _motionEventId = -1;
    
    /*
     * Registers all listeners at construction time of the KeyCtrl-class.
     */
    var _registerListeners = Lang.bind(this, function() {
        // Listener which detects when all windows are at their final position 
        // within the overview and gets the state of the active workspace. 
        ext.connect(
            _workspacesView.getActiveWorkspace(),
            'window-ready',
            Lang.bind(this, function() {
                _windowReadyCount += 1;
                if (_windowReadyCount == _workspacesView
                                         .getActiveWorkspace()
                                         .getWindowOverlays()
                                         .length) {
                    this.onOverviewReady();
                    _windowReadyCount = 0;
                }
            })
        );
        // Listener for cleanup before the hiding-animation starts.
        ext.connect(
            Main.overview,
            'hiding-starts',
            Lang.bind(this, function() {
                this.onOverviewHiding();
            })
        );
        // Listener for getting the state of the new workspace.
        ext.connect(
            global.window_manager,
            'switch-workspace',
            Lang.bind(this, function() {
                this.onOverviewReady();
            })
        );
        // Listener for key-press-events. This is where KeyCtrl comes to life.
        ext.connect(
            global.stage,
            'key-press-event',
            Lang.bind(this, function(actor, event) {
                this.onKeyPress(event);
            })
        ); 
    });
    _registerListeners();
    
    /*
     * Calculates the Manhattan-Distance of two windows in overview mode. 
     * @param sw: Selected window.
     * @param cw: Currently evaluated window.
     * @return: Number
     */
    var _calcDistance = function(sw, cw) {
        return Math.abs(sw.center_x - cw.center_x) + 
               Math.abs(sw.center_y - cw.center_y);
    };
    
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
        if(_navMemoryActive && _navMemory[_arrowKeyIndex][key]) {
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
                let distance = _calcDistance(sw, cw);
                if (conditionCb(sw, cw, distance, minDistance)) {
                    _arrowKeyIndex = i;
                    minDistance = distance;
                }
            } 
        }
        // Store reverse navigation rule.
        if (_navMemoryActive && _arrowKeyIndex != currArrowKeyIndex) {
            _navMemory[_arrowKeyIndex][reverseKey] = currArrowKeyIndex;
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
     * Tidy up all actors and adjustments that were introduced during the
     * selection process.
     * @param resetG: Flag which indicates if the geometry of the 
     * @param hideB: Flag which indicates if the border of the active window
     * selected window should be reset.
     */
    var _endSelection = function(resetG) {
        if (_selecting) {
            _selected.unselect(resetG);
            _lightbox.hide();
            _lightbox.destroy();
            _lightbox = null;
            ext.disconnect(_buttonPressEventId);
            ext.disconnect(_motionEventId);
        }
        _arrowKeyIndex = 0;
        _navMemory = [];
        _windowOverlays = [];
        _selected = null;
        _selecting = false;
        _upToDate = false;
    };
    
    /*
     * Starts the selection process and highlights the active window.
     */
    var _startSelection = function() {
        _lightbox = new Lightbox.Lightbox(Main.layoutManager.overviewGroup);
        _lightbox.show();
        // Mouse events stop the keyboard selection.
        _buttonPressEventId = ext.connect(
            global.stage,
            'button-press-event', 
            Lang.bind(this, function() {
                _endSelection(true);
                _active.setFocus(true);
            })
        );
        _motionEventId = ext.connect(
            global.stage,
            'motion-event', 
            Lang.bind(this, function() {
                _endSelection(true);
                _active.setFocus(true);
            })
        );
        _selecting = true;
    };
    
    /*
     * Selects and highlights windows based on arrow key input.
     * @param key: Pressed arrow key.
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
            _selected.select(_lightbox);
        } else if (first) {
            _selected.select(_lightbox);
        }
    };
    
    /*
     * Get the current state of the overview and prepare members for the 
     * selection process.
     */
    var _updateOverviewState = function() {
        _windowOverlays = _workspacesView.getWindowOverlays();
        let focus = global.screen.get_display().focus_window;
        for (var i = 0; i < _windowOverlays.length; i++) {
            let windowOverlay = _windowOverlays[i];
            windowOverlay.setFocus(false);
            // Store initial geometry.
            windowOverlay.getWindowClone().createGeometrySnapshot();
            // Initialize a navigation memory for each window overlay.
            _navMemory[i] = {};
            // Find window which has focus. If no window has focus select 
            // the last window in the list - for example on GNOME Shell restart.
            if (windowOverlay.getMetaWindow() == focus ||
                i == _windowOverlays.length - 1) {
                _arrowKeyIndex = i;
                _selected = windowOverlay;
                _active = _selected;
                _active.setFocus(true);
            }
        }
        _upToDate = true;
    };
    
    /*
     * Checks if everything is ready for the selection process to start.
     * @return: boolean
     */
    var _canSelect = function() {
        return _windowOverlays.length > 0 && 
               _overviewReady &&
               !_workspacesView.getActiveWorkspace().isRepositioning() &&
               // No popping windows while on applications-tab or the like.
               Main.overview.viewSelector.getActivePage() == 
               ViewSelector.ViewPage.WINDOWS;
    };
    
    /*
     * Checks what to do when an arrow key was pressed and calls the appropriate
     * methods.
     * @param key: Pressed arrow key.
     */
    var _onArrowKeyPress = function(key) {
        if (!_upToDate) {
            _updateOverviewState();
        }
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
        // End selection before workspacesView gets destroyed.
        _endSelection(true);
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
            _overviewReady = false;
            _endSelection(false);
            window.change_workspace_by_index(
                workspaceIndex, 
                false, 
                global.get_current_time()
            ); 
        }
    };
    
    /*
     * Closes the currently selected window when the delete key is pressed.
     */
    var _onDeleteKeyPress = function() {
        _overviewReady = false;
        _windowOverlays[_arrowKeyIndex].closeWindow();
        _endSelection(false);
    };
    
    /*
     * Activates the currently selected window when the return key is pressed.
     */
    var _onReturnKeyPress = function() {
        let metaWindow = _windowOverlays[_arrowKeyIndex].getMetaWindow();
        if (_selecting) {
            _endSelection(false); 
        }
        Main.activateWindow(metaWindow, global.get_current_time());
    };
    
    /*
     * Callback for getting overview-state when all windows are ready.
     */
    this.onOverviewReady = function() {
        _updateOverviewState();
        _overviewReady = true;
    };
    
    /*
     * Ends the current selection process when the overview starts hiding.
     */
    this.onOverviewHiding = function() {
        _active.setFocus(false);
        _endSelection(false);
    };
    
    /*
     * Callback function that is triggered by 'key-press-events' and delegates 
     * to the according subroutines.
     * @param event: The event object. 
     */
    this.onKeyPress = function(event) {
        let key = event.get_key_symbol();
        // Select and highlight windows in overview-mode.
        if (key == Clutter.Up || key == Clutter.Down || 
            key == Clutter.Left || key == Clutter.Right) {
            _onArrowKeyPress(key);
        // Switch workspace
        } else if (key == Clutter.Page_Down || key == Clutter.Page_Up || 
                   key ==Clutter.Home || key ==Clutter.End) {
            _onPageKeyPress(key);
         // Move window when F1-F12 is pressed
        } else if(_selecting && key >= Clutter.F1 && key <= Clutter.F12) {
            _onFunctionKeyPress(key);
        // Close window when del is pressed.
        } else if (_selecting && key == Clutter.Delete) {
            _onDeleteKeyPress();
        // Activate the selected window when return is pressed.
        } else if (key == Clutter.Return) {
            _onReturnKeyPress();
        } else if (_selecting) {
            _endSelection(true);
            _active.setFocus(true);
        } 
    };
    
    /*
     * Disconnects all listeners when the WorkspacesView gets destroyed.
     */
    this.destroy = function() {
        ext.disconnectAll();
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
            this.emit('hiding-starts');
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// WorkspacesView //////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Here we go...
     */
    ext.injectAfter(
        WorkspacesView.WorkspacesView, 
        '_init', 
        function() {
            this._keyCtrl = new KeyCtrl(this, ext.settings);
        }
    );
    
    /*
     * Here we leave...
     */
    ext.injectAfter(
        WorkspacesView.WorkspacesView, 
        '_onDestroy', 
        function() {
            this._keyCtrl.destroy();
        }
    );
    
    /*
    * Getter for window overlays of the active workspace and surrounding
    * extra workspaces on different monitors.
    * @return: [ WindowOverlay ]
    */
    WorkspacesView.WorkspacesView.prototype.getWindowOverlays = function() {
        let windowOverlays = this.getActiveWorkspace().getWindowOverlays();
        // TODO add overlays from ExtraWorkspaces. this._extraWorkspaces
        // was removed from WorkspacesView.
        return windowOverlays;
     };
    
////////////////////////////////////////////////////////////////////////////////
// Workspace ///////////////////////////////////////////////////////////////////   
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Getter for window overlays of a workspace. 
     * @return: [ WindowOverlay ]
     */
    Workspace.Workspace.prototype.getWindowOverlays = function() {
        return this._windowOverlays.slice();
    };
    
    /*
     * Returns true if the workspace is repositioning its windows.
     * @return: Boolean.
     */
    Workspace.Workspace.prototype.isRepositioning = function() {
        return this._repositionWindowsId > 0;
    };
    
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
     * WorkspacesView._startSelection.
     */
    Workspace.WindowClone.prototype.select = function(lightbox) {
        // Store the original parent and highlight the window.
        this._origParent = this.actor.get_parent();
        this._origSibling = this.actor.get_previous_sibling();
        this.actor.raise_top();
        this.actor.reparent(Main.layoutManager.overviewGroup);
        lightbox.highlight(this.actor);
        // Define the available area.
        let monitorIndex = this.metaWindow.get_monitor();
        let availArea = Main.layoutManager.monitors[monitorIndex];
        let padding = 30;
        let limitTop = availArea.y + padding;
        let limitBottom = availArea.y + availArea.height - padding;
        let limitLeft = availArea.x + padding;
        let limitRight = availArea.x + availArea.width - padding;
        let limitWidth = limitRight - limitLeft;
        let limitHeight = limitBottom - limitTop;
        // Calculate the desired new dimension.
        let factor = ext.settings.ZOOM_FACTOR;
        let newScaleX = this.actor.scale_x * factor;
        let newScaleY = this.actor.scale_y * factor;
        let newWidth = this.actor.width * newScaleX;
        let newHeight = this.actor.height * newScaleY;
        // Adjust the dimension to the available area.
        while (newWidth > limitWidth || newHeight > limitHeight || 
               newScaleX > 1.0 || newScaleY > 1.0) {
            factor -= 0.1;
            newScaleX = this.actor.scale_x * factor;
            newScaleY = this.actor.scale_y * factor;
            newWidth = this.actor.width * newScaleX;
            newHeight = this.actor.height * newScaleY;
        }
        // Calculate the desired new position.
        let deltaWidth =  newWidth - this.actor.width * this.actor.scale_x;
        let deltaHeight = newHeight - this.actor.height * this.actor.scale_y;
        let newX = this.actor.x - deltaWidth / 2;
        let newY = this.actor.y - deltaHeight / 2;
        // Adjust the new position to the available area.
        if (monitorIndex == Main.layoutManager.primaryIndex){
            limitTop += Main.panel.actor.height;
        }
        if (newX + newWidth > limitRight) newX = limitRight - newWidth;
        if (newX < limitLeft) newX = limitLeft;
        if (newY + newHeight > limitBottom) newY = limitBottom - newHeight;
        if (newY < limitTop) newY = limitTop;
        // Zoom the window.
        Tweener.addTween(this.actor, { 
            x: newX,
            y: newY,
            scale_x: newScaleX,
            scale_y: newScaleY,
            time: ext.settings.FOCUS_TIME,
            transition: 'easeOutQuad' 
         });
    };
        
    /*
     * Reverts the adjustments done by WindowClone.select.
     * @param resetG: Flag which indicates if the geometry 
     * should be reset.
     */
    Workspace.WindowClone.prototype.unselect = function(resetG) {
        if (resetG) {
            this.actor.x = this.storedGeometry.x; 
            this.actor.y = this.storedGeometry.y;
            this.actor.scale_x = this.storedGeometry.scale_x;
            this.actor.scale_y = this.storedGeometry.scale_y; 
        }
        if (this._origParent) {
            this.actor.reparent(this._origParent);
            if (this._origSibling) {
                this.actor.raise(this._origSibling);
            } else {
                this.actor.lower_bottom();
            }
            Tweener.removeTweens(this.actor);
        }
    };
    
    /*
     * Creates a snapshot of the window geometry.
     */
    Workspace.WindowClone.prototype.createGeometrySnapshot = function() {
        let width = this.actor.width * this.actor.scale_x;
        let height = this.actor.height * this.actor.scale_y;
        this.storedGeometry = {
            x: this.actor.x, 
            y: this.actor.y,
            width: width,
            height: height, 
            scale_x: this.actor.scale_x,
            scale_y: this.actor.scale_y,
            center_x: this.actor.x + width / 2,
            center_y: this.actor.y + height / 2
        };
    };
    
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
    Workspace.WindowOverlay.prototype.select = function(lightbox) {
        this.hide();
        this.setFocus(false);
        this._windowClone.select(lightbox);
    };
    
    /*
     * Unselects the associated window. See WindowClone.unselect.
     * @param resetG: Flag which indicates if the geometry should be reset.
     * @param hideB: Flag which indicates if the boder of the active window
     * should be hided. 
     */
    Workspace.WindowOverlay.prototype.unselect = function(resetG) {
        this.show();
        this.setFocus(false);
        this._windowClone.unselect(resetG);
    };
    
    /*
     * Marks the last active window with a border or removes that border again.
     * @param set: Flag to indicate whether the window should be marked as 
     * focused/active or not.
     */
    Workspace.WindowOverlay.prototype.setFocus = function(set) {
        if (set) {
            this.activeBorderInner.show();
            this.activeBorderOuter.show();
        } else {
            this.activeBorderInner.hide();
            this.activeBorderOuter.hide();
        }
    };
    
    /*
     * Closes the associated window.
     */
    Workspace.WindowOverlay.prototype.closeWindow = function() {
        this._closeWindow();
    };
    
    /*
     * Returns a geometry-info object of the window clone.
     * @return: Object.
     */
    Workspace.WindowOverlay.prototype.getStoredGeometry = function() {
        return this._windowClone.storedGeometry;
    };
    
    /*
     * Getter for the window clone.
     * @return: WindowClone.
     */
    Workspace.WindowOverlay.prototype.getWindowClone = function() {
        return this._windowClone;
    };
    
    /*
     * Getter for the meta window.
     * @return: MetaWindow.
     */
    Workspace.WindowOverlay.prototype.getMetaWindow = function() {
        return this._windowClone.metaWindow;
    };
    
    log('Arrow Key Window Selector enabled');
}
    
    
function disable() {
    ext.cleanUp();
    log('Arrow Key Window Selector disabled');
}
