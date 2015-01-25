/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const Tweener = imports.ui.tweener;
const ViewSelector = imports.ui.viewSelector;

// Constants that affect the behavior of the extension.
function KeyCtrlConfig() {
    // Distance which is considered a motion.
    this.MOTION_THRESHOLD = 5;
    // Zooming windows stay within the monitor-dimension minus 
    // the defined padding 
    this.PADDING = 30;
    // Maximum factor for zooming windows.
    this.ZOOM_FACTOR = 1.5;
    // Duration of the zooming-animation.
    this.ZOOM_TIME = 0.15;
    // If true, navigation steps are always reversible.
    this.MEMORY = true;
}

/*
 * Class for enhanced keyboard navigation in overview mode.
 * @param workspacesDisplay: Reference to the WorkspacesDisplay. 
 * @param ext: Helper for applying and removing patches.
 * @param cfg: Object containing constants.
 */
function KeyCtrl(workspacesDisplay, ext, cfg) {
    // Index of the window that is - or is to be - selected.
    let _arrowKeyIndex = 0;
    let _initialIndex = 0;
    // Navigation memory for making every navigation-step reversible. 
    // Otherwise you could navigate into one direction
    // and the next move into the opposite direction would not bring
    // you back to the origin if there was a closer
    // window in that direction. As a (positive) side effect navigation 
    // rules are cached.
    let _navMemory = [];
    let _navMemoryActive = cfg.MEMORY;
    let _workspacesDisplay = workspacesDisplay;
    let _workspacesViews = workspacesDisplay._workspacesViews;
    let _viewsAgent = _workspacesViews[0];
    // Window overlays of the overview.
    let _windowOverlays = [];
    // Number of before mentioned windows which have already arrived
    // their final position within the overview.
    let _windowReadyCount = 0;
    let _lightbox = null;
    // The currently selected window. Actually it's the window overlay 
    // because it contains the most information and has access to other 
    // abstractions.
    let _selected = null;
    // The active window.
    let _active = null;
    // Flag to indicate if a window selection takes place.
    let _selecting = false;
    // Flags to indicate events or changes of the overview.
    let _upToDate = false;
    let _blocked = false;
    let _inDrag = false;
    // Storage for pointer-movement data. Defined in _initSelection.
    let _deltaMotion;
    // Declaration of containers for distinct sets of listener-IDs.
    let _windowReadyEventIds = [];
    let _transientEventIds = [];
    let _selectionEventIds = [];
    
    /*
     * Registers listeners which will be removed after the overview has
     * finished its initial "zooming-in".
     */
    let _registerInitListeners = Lang.bind(this, function() {
        _workspacesViews.forEach(Lang.bind(this, function(view) {
            // Detects when windows arrive at their final position during
            // "zooming-in" of the overview.
            _windowReadyEventIds.push(ext.connect(
                view.getActiveWorkspace(),
                'window-ready',
                Lang.bind(this, function() {
                    this.onWindowReady();
                })
            ))
        }))
    });
    _registerInitListeners();
    
    /*
     * Registers listeners at construction time and whenever the active 
     * workspace changes.
     */
    let _registerTransientListeners = Lang.bind(this, function() {
        _workspacesViews.forEach(Lang.bind(this, function(view) {
            // Blocks KeyCtrl while windows are - or are about to - change their
            // positions.
            _transientEventIds.push(ext.connect(
                view.getActiveWorkspace(),
                'window-positioning-init',
                function() {
                    _blocked = true; 
                }
            ));
            // Detects when the window-animation starts, triggers an update 
            // after the animation has ended and removes the block for KeyCtrl.
            _transientEventIds.push(ext.connect(
                view.getActiveWorkspace(),
                'window-positioning-start',
                Lang.bind(this, function() {
                    this.onWindowPositioningStart(); 
                })
            ));
        }))
    });
    _registerTransientListeners();
    
    /*
     * Registers listeners at construction time of the KeyCtrl-class. Their
     * lifespan is identical with the one of KeyCtrl. 
     */
    let _registerPermanentListeners = Lang.bind(this, function() {
         // Listener for key-press-events. This is where KeyCtrl comes to life.
        ext.connect(
            global.stage,
            'key-press-event',
            Lang.bind(this, function(actor, event) {
                this.onKeyPress(event);
            })
        );
        // Updates the stored overview-state when windows enter or leave the
        // monitor. It is also called when windows are added or removed from
        // a workspace.
        ext.connectMulti(
            global.screen,
            ['window-entered-monitor', 'window-left-monitor'],
            Lang.bind(this,function() {
                _upToDate = false;
                this.updateOverviewState(false);
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
                ext.disconnect(_transientEventIds);
                _transientEventIds = [];
                _registerTransientListeners();
                this.updateOverviewState(true);
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
    let _calcManhattanDistance = function(x1, x2, y1, y2) {
        return Math.abs(x1 - x2) + Math.abs(y1 - y2);
    };
    
    /*
     * Calculates the Manhattan-Distance of two windows in overview mode. 
     * @param sw: Selected window.
     * @param cw: Currently evaluated window.
     * @return: Number
     */
    let _calcWindowDistance = function(sw, cw) {
        return _calcManhattanDistance(
                   sw.center_x, cw.center_x, 
                   sw.center_y, cw.center_y
               );
    };
    
    /*
     * Checks if the movement of the pointer exceeds a certain threshold.
     * Otherwise a slight vibration of the table would stop the selection.
     * @param event: Event object which holds the current pointer position. 
     */
    let _isMotion = function(event) {
        let coords = event.get_coords();
        let delta = _calcManhattanDistance(
            _deltaMotion[0], coords[0],
            _deltaMotion[1], coords[1]
        );
        _deltaMotion = coords;
        return delta > cfg.MOTION_THRESHOLD;
    }
    
    /*
     * Subroutine for workspacesView._updateArrowKeyIndex. It finds the closest
     * window in the given direction and is therefore independent of window-
     * positioning-strategies.
     * @param key: Pressed key.
     * @param reverseKey: Key for reverse navigation.
     * @param conditionCb: Callback which decides whether the currently 
     * tested window is, in the defined direction, closer than the previous one. 
     */
    let _updateArrowKeyIndexSub = function(key, reverseKey, conditionCb) {
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
            _windowOverlays.forEach(function(overlay, index) {
                let cw = overlay.getStoredGeometry();
                let distance = _calcWindowDistance(sw, cw);
                if (conditionCb(sw, cw, distance, minDistance)) {
                    _arrowKeyIndex = index;
                    minDistance = distance;
                }
            })
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
    let _updateArrowKeyIndex = function(key) {
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
    let _updateOverviewState = function() {
        _windowOverlays = _workspacesDisplay.getWindowOverlays(_upToDate);
        _upToDate = true;
        let focus = global.screen.get_display().focus_window;
        let focusFound = false;
        _windowOverlays.forEach(function(windowOverlay, index) {
            windowOverlay.setFocus(false);
            // Store initial geometry.
            windowOverlay.getWindowClone().createGeometrySnapshot();
            // Initialize a navigation memory for each WindowOverlay.
            _navMemory[index] = {};
            // Find the focused window. If no window has focus select 
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
     * @param resetKeyCtrl: Reset the stored state of the overview! 
     */
    let _resetSelection = function(resetG, resetKeyCtrl) {
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
                _lightbox = null;
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
     * Initializes the selection process and registers listeners which will 
     * stop it again.
     */
    let _initSelection = function() {
        _initialIndex = _arrowKeyIndex;
        _lightbox = new Lightbox.Lightbox(Main.layoutManager.overviewGroup);
        _lightbox.show();
        _deltaMotion = global.get_pointer();
        _selecting = true;
        // Mouse events stop the keyboard selection.
        _selectionEventIds.push(ext.connect(
            global.stage,
            'button-press-event', 
            Lang.bind(this, function() {
                _resetSelection(true, true);
            })
        ));
        _selectionEventIds.push(ext.connect(
            global.stage,
            'motion-event', 
            Lang.bind(this, function(actor, event) {
                if (_isMotion(event)) {
                    _resetSelection(true, false);
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
    let _select = function(key, first) {
        let currArrowKeyIndex = _arrowKeyIndex;
        // Find the index of the window that is to be selected based 
        // on the keyboard input. The result is saved in the member
        // _arrowKeyIndex.
        _updateArrowKeyIndex(key);
        // Select and highlight the window if the navigation was valid.
        if (_arrowKeyIndex != currArrowKeyIndex) {
            _selected.unselect(true, true);
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
    let _canSelect = function() {
        return _windowOverlays.length > 0 && 
               !_blocked && 
               // Avoids popping windows while navigating the applications page.
               Main.overview.viewSelector.getActivePage() == 
               ViewSelector.ViewPage.WINDOWS;
    };
    
    /*
     * Checks what to do when an arrow key was pressed and calls the appropriate
     * methods.
     * @param key: Pressed arrow key.
     */
    let _onArrowKeyPress = function(key) {
        if (_canSelect()) {
            let first = false;
            if (!_selecting) {
                _initSelection();
                first = true;
            }
            _select(key, first);
        } 
    };
    
    /*
     * Switches the active workspace when defined keys are pressed.
     * @param key: switch-defining keyboard key.
     */
    let _onPageKeyPress = function(key) {
        let activeIndex = global.screen.get_active_workspace_index();
        let previousIndex = activeIndex;
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
        if (activeIndex < global.screen.get_n_workspaces() && 
            activeIndex >= 0 &&
            activeIndex != previousIndex) {
            _resetSelection(true, true);
            global.screen.get_workspace_by_index(activeIndex).activate(true);
        }
    };
    
    /*
     * If the last window of the active workspace was removed there is
     * no animation and the update of the overview state does'nt get 
     * triggered at the end of the animation.  
     */
    let _manualUpdateCheck = function() {
        if (_workspacesDisplay.getWindowCount(false) == 0) {
            _blocked = false;
            _updateOverviewState();
        }
    };
    
    /*
     * Moves the selected window to the workspace with the number of the
     * function key i.e. F1 -> workspace 1.
     * @param key: function key identifier.
     */
    let _onFunctionKeyPress = function(key) {
        _viewsAgent.getActiveWorkspace().keyCtrlActive = true;
        _blocked = true;
        // F1 means workspace 1 which is at index 0.
        let workspaceIndex = key - Clutter.F1;
        let activeIndex = global.screen.get_active_workspace_index();
        if (_selected && 
            workspaceIndex < global.screen.get_n_workspaces() &&
            workspaceIndex != activeIndex) {
            let window = _selected.getMetaWindow();
            window.change_workspace_by_index(
                workspaceIndex, 
                false, 
                global.get_current_time()
            );
            _resetSelection(false, true);
            _manualUpdateCheck();
        }
    };
    
    /*
     * Closes the currently selected window when the delete key is pressed.
     */
    let _onDeleteKeyPress = function() {
        _viewsAgent.getActiveWorkspace().keyCtrlActive = true;
        _blocked = true;
        _windowOverlays[_arrowKeyIndex].closeWindow();
        _resetSelection(false, true);
        _manualUpdateCheck();
    };
    
    /*
     * Activates the currently selected window when the return key is pressed.
     */
    let _onReturnKeyPress = function() {
        let metaWindow = _windowOverlays[_arrowKeyIndex].getMetaWindow();
        if (_selecting) {
            _resetSelection(false, true); 
        }
        Main.activateWindow(metaWindow, global.get_current_time());
    };
    
    /*
     * Called when the active workspace starts to reposition its windows.
     */
    this.onWindowPositioningStart = function() {
        // Not on overview-init and when windows are dragged.
        if (_windowReadyEventIds.length == 0 && !_inDrag) {
            _upToDate = false;
            ext.addTimeout(
                // Overview animation time is defined in seconds... 
                Overview.ANIMATION_TIME * 1000 + 100,
                Lang.bind(this, function() {
                    _blocked = false;
                    this.updateOverviewState(false);
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
            // Only applied when the overview is initialized (to be quick).
            ext.disconnect(_windowReadyEventIds);
            _windowReadyEventIds = [];
            this.updateOverviewState(false);
        }
        _upToDate = true;
    };
    
    /*
     * Updates the state of the active workspace.
     * @param resetSelection: Tells if the selection should be reset before.
     */
    this.updateOverviewState = function(resetSelection) {
        if (!_blocked && !_selecting) {
            if(resetSelection) {
                _resetSelection(false, true); 
            }
            _updateOverviewState();
        }
    };
    
    /*
     * Ends the current selection process when the overview starts hiding.
     */
    this.onOverviewHiding = function() {
        _resetSelection(false, true);
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
        } else if(key >= Clutter.F1 && key <= Clutter.F12) {
            _onFunctionKeyPress(key);
        // Close window when del is pressed.
        } else if (key == Clutter.Delete) {
            _onDeleteKeyPress();
        // Activate the selected window when return is pressed.
        } else if (key == Clutter.Return) {
            _onReturnKeyPress();
        } else if (_selecting) {
            _resetSelection(true, false);
        } 
    };
    
    /*
     * Disconnects all listeners and removes all timeouts. 
     * Thalamus shuts down...
     */
    this.sleep = function() {
        _resetSelection(false, true);
        ext.disconnectAll();
        ext.removeAll();
    };
}