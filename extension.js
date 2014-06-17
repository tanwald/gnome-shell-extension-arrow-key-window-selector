/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Shell = imports.gi.Shell;
const Tweener = imports.ui.tweener;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

////////////////////////////////////////////////////////////////////////////////
//Helper ///////////////////////////////////////////////////////////////////////   
////////////////////////////////////////////////////////////////////////////////

/*
 * Helper function for injecting code into existing
 * functions. Taken from other extensions.
 * @param parent: Parent class.
 * @param name: Name of the function.
 * @param func: Function which is to be injected.
 * @return: Return-value of the original or injected function.
 */
function injectToFunction(parent, name, func) {
    let origin = parent[name];
    parent[name] = function() {
        let ret;
        ret = origin.apply(this, arguments);
        if (ret === undefined) {
            ret = func.apply(this, arguments);
        }
        return ret;
    };
}

/*
 * Class for enhanced keyboard navigation in overview mode.
 * @param workspaceView: Reference to the current WorkspaceView. 
 */
function KeyCtrl(workspaceView) {
    
////////////////////////////////////////////////////////////////////////////////
// Private /////////////////////////////////////////////////////////////////////   
////////////////////////////////////////////////////////////////////////////////
    
    // Constants.
    var _INVISIBLE = 255;
    var _VISIBLE = 0;
    // Index of the window that is - or is to be - selected.
    var _arrowKeyIndex = 0;
    // Navigation memory for making every navigation-step reversible. 
    // Otherwise you could navigate into one direction
    // and the next move into the opposite direction would not bring
    // you back to the origin if there was a closer
    // window in that direction. As a side effect navigation 
    // rules are cached.
    var _navMemory = [];
    // The currently selected window. Actually it's the window overlay 
    // because it contains the most information and has access to other 
    // abstractions.
    var _selected = null;
    var _workspaceView = workspaceView;
    var _windowOverlays = [];
    var _lightbox = null;
    var _selecting = false;
    // Declaration of listener-IDs.
    var _buttonPressEventId = -1;
    var _motionEventId = -1;
    
    /*
     * Initialization for members.
     */
    var _init = function() {
        _windowOverlays = _workspaceView.getWindowOverlays();
        let focus = global.screen.get_display().focus_window;
        for (var i in _windowOverlays) {
            // Find window which has focus.
            if (_windowOverlays[i].getMetaWindow() == focus) {
                _arrowKeyIndex = i;
                _selected = _windowOverlays[i];
                _selected.border.opacity = _VISIBLE;
                log(_selected);
            }
            // Store initial geometry.
            _windowOverlays[i].getWindowClone().createGeometrySnapshot();
            // Initialize a navigation memory for each window overlay.
            _navMemory[i] = {};
        }
    };
    _init();
    
    /*
     * Tidy up all actors and adjustments that were introduced during the
     * selection process.
     * @param resetGeometry: Flag which indicates if the geometry of the 
     * selected window should be reset.
     */
    var _endSelection = function(resetGeometry) {
        if (_selecting) {
            global.stage.disconnect(_buttonPressEventId);
            global.stage.disconnect(_motionEventId);
            _arrowKeyIndex = 0;
            _navMemory = [];
            _selected.unselect(resetGeometry);
            _selected = null;
            _windowOverlays = [];
            _lightbox.hide();
            _lightbox.destroy();
            _lightbox = null;
            _selecting = false;
        }
    };
    
    /*
     * TODO
     */
    var _initSelection = function() {
        _selected.border.opacity = _INVISIBLE;
        _lightbox = new Lightbox.Lightbox(Main.layoutManager.overviewGroup);
        _lightbox.show();
        _buttonPressEventId = global.stage.connect(
            'button-press-event', 
            function() {
                _endSelection(true);
            }
        );
        _motionEventId = global.stage.connect(
            'motion-event', 
            function() {
                _endSelection(true);
            }
        );
    };
    
    
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
     * Subroutine for WorkspaceView._updateArrowKeyIndex. It finds the closest
     * window in the given direction and is therefore independent of window-
     * positioning-strategies.
     * @param key: Pressed key.
     * @param reverseKey: Key for reverse navigation.
     * @param conditionCb: Callback which decides whether the current window in
     * a loop is closer in the defined direction than the previous one. 
     */
    var _updateArrowKeyIndexSub = function(key,reverseKey, conditionCb) {
        let currArrowKeyIndex = _arrowKeyIndex;
        if(_navMemory[_arrowKeyIndex][key]) {
            // Retrieve navigation rule.
            _arrowKeyIndex = _navMemory[_arrowKeyIndex][key];
        } else {
            // Find closest window in that direction.
            // sw ... selected window.
            // cw ... current window.
            let sw = _selected.getStoredGeometry();
            // Just in case some user has infinite resolution...
            let minDistance = Number.POSITIVE_INFINITY;
            for (var i in _windowOverlays) {
                let cw = _windowOverlays[i].getStoredGeometry();
                let distance = _calcDistance(sw, cw);
                if (conditionCb(sw, cw, distance, minDistance)) {
                    _arrowKeyIndex = i;
                    minDistance = distance;
                }
            } 
        }
        // Store reverse navigation rule.
        if (_arrowKeyIndex != currArrowKeyIndex) {
            _navMemory[_arrowKeyIndex][reverseKey] = currArrowKeyIndex;
        }
    };
    
    /*
     * Contains all the logic for selecting a new window based on arrow key 
     * input.
     * @param key: Pressed key.
     * @param windowOverlays: Window overlays of the active workspace and extra 
     * workspaces.
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
     * Selects and highlights windows based on arrow key input.
     * @param key: Pressed arrow key.
     */
    var _onArrowKeyPress = function(key) {
        // Stop immediately if there are no windows or if they need 
        // repositioning.
        if (_windowOverlays.length > 0 && 
            !_workspaceView.getActiveWorkspace().isRepositioning()) {
            if (!_selecting) {
                _initSelection();
                _selecting = true;
            }
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
            }
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
        // End selection before WorkspaceView gets destroyed.
        _endSelection(false);
        if (activeIndex >= 0 && activeIndex < global.screen.get_n_workspaces()) {
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
        if (workspaceIndex < global.screen.get_n_workspaces()) {
            let window = _selected.getMetaWindow();
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
        let windowOverlay = _windowOverlays[_arrowKeyIndex];
        windowOverlay.closeWindow();
    };
    
    /*
     * Activates the currently selected window when the return key is pressed.
     */
    var _onReturnKeyPress = function() {
        let metaWindow = _windowOverlays[_arrowKeyIndex].getMetaWindow();
        _endSelection(false);
        Main.activateWindow(metaWindow, global.get_current_time());
    };
    
    /*
     * Callback function that is triggered by 'key-press-events' and delegates 
     * to the according subroutines.
     * @param actor: Actor which emits the event.
     * @param event: The event object. 
     */
    this.onKeyPress = function(actor, event) {
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
        } else if (_selecting && key == Clutter.Return) {
            _onReturnKeyPress();
        }  else {
            _endSelection(true);
        }
    };
    
    this._keyPressEventId = global.stage.connect(
        'key-press-event', 
        Lang.bind(this, this.onKeyPress)
    );
    
////////////////////////////////////////////////////////////////////////////////
// Public //////////////////////////////////////////////////////////////////////   
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Restores the original state of the Gnome Shell.
     */
    this.destroy = function() {
        global.stage.disconnect(this._keyPressEventId);
    };
}

function enable() {

////////////////////////////////////////////////////////////////////////////////
// WorkspaceView ///////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * TODO
     */
    injectToFunction(
        WorkspacesView.WorkspacesView.prototype, 
        '_init', 
        function() {
            this._keyCtrl = new KeyCtrl(this);
        }
    );
    
    /*
     * TODO
     */
    injectToFunction(
        WorkspacesView.WorkspacesView.prototype, 
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
        for (var i in this._extraWorkspaces) {
            windowOverlays.push.apply(
                windowOverlays,
                this._extraWorkspaces[i].getWindowOverlays()
            );
        }
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
    
////////////////////////////////////////////////////////////////////////////////
// WindowClone /////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Introduces a dictionary for window geometry.
     */
    injectToFunction(
        Workspace.WindowClone.prototype, 
        '_init', 
        function(realWindow) {
            this.storedGeometry = {};
        }
    );
    
    /*
     * Highlights and zooms the currently selected window.
     * @param lightbox: A reference to the lightbox introduced by 
     * WorkspacesView._initSelection.
     * @param windowCount: Number of windows on the active workspace.
     */
    Workspace.WindowClone.prototype.select = function(lightbox) {
        // Store the original parent and highlight the window.
        this._origParent = this.actor.get_parent();
        this.actor.reparent(Main.layoutManager.overviewGroup);
        this.actor.raise_top();
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
        let factor = 1.3;
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
            time: 0.2,
            transition: 'easeOutQuad' 
            });
    };
        
    /*
     * Reverts the adjustments done by WindowClone.select.
     * @param resetGeometry: Flag which indicates if the geometry 
     * should be reset.
     */
    Workspace.WindowClone.prototype.unselect = function(resetGeometry) {
        Tweener.removeTweens(this.actor);
        this.actor.reparent(this._origParent);
        if (resetGeometry) {
            this.actor.x = this.storedGeometry.x; 
            this.actor.y = this.storedGeometry.y;
            this.actor.scale_x = this.storedGeometry.scale_x;
            this.actor.scale_y = this.storedGeometry.scale_y; 
        }
    }
    
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
    }
    
////////////////////////////////////////////////////////////////////////////////
// WindowOverlay ///////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
         /*
     * Selects the associated window. See WindowClone.select.
     * @param lightbox: A reference to the lightbox introduced by 
     * KeyCtrl's _initSelection.
     */
    Workspace.WindowOverlay.prototype.select = function(lightbox) {
        this.hide();
        this._windowClone.select(lightbox);
    }
    
    /*
     * Unselects the associated window. See WindowClone.unselect.
     * @param resetGeometry: Flag which indicates if the geometry 
     * should be reset.
     */
    Workspace.WindowOverlay.prototype.unselect = function(resetGeometry) {
        this.show();
        this._windowClone.unselect(resetGeometry);
    }
    
    /*
     * Closes the associated window.
     */
    Workspace.WindowOverlay.prototype.closeWindow = function() {
        this._closeWindow();
    }
    
    /*
     * Returns a geometry-info object of the window clone.
     * @return: Object.
     */
    Workspace.WindowOverlay.prototype.getStoredGeometry = function() {
        return this._windowClone.storedGeometry;
    }
    
    /*
     * Getter for the window clone.
     * @return: WindowClone.
     */
    Workspace.WindowOverlay.prototype.getWindowClone = function() {
        return this._windowClone;
    }
    
    /*
     * Getter for the meta window.
     * @return: MetaWindow.
     */
    Workspace.WindowOverlay.prototype.getMetaWindow = function() {
        return this._windowClone.metaWindow;
    }
    
    log('Arrow Key Window Selector enabled');
}
    
    
function disable() {
    log('Arrow Key Window Selector disabled');
}