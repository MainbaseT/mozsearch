function atUnescape(text) {
  return text.replace(/@([0-9A-F][0-9A-F])/g, (_, s) => String.fromCharCode(parseInt(s, 16)));
}

var ContextMenu = new (class ContextMenu {
  constructor() {
    this.menu = document.createElement("ul");
    this.menu.className = this.menu.id = "context-menu";
    this.menu.tabIndex = 0;
    this.menu.style.display = "none";
    document.body.appendChild(this.menu);

    this.selectedToken = null;

    this.menu.addEventListener("mousedown", function (event) {
      // Prevent clicks on the menu to propagate
      // to the window, so that the menu is not
      // removed and links will be followed.
      event.stopPropagation();
    });

    window.addEventListener("mousedown", () => this.hide());
    window.addEventListener("pageshow", () => this.hide());
    window.addEventListener("click", event => this.tryShowOnClick(event));
  }

  fmt(s, data) {
    data = data
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
    return s.replace("_", data);
  }

  fmtLang(lang) {
      lang = lang.toUpperCase();
      if (lang === "CPP") {
        lang = "C++";
      }
      return lang;
  }

  generatePseudoFileSymInfo(sym) {
    let file = atUnescape(sym.replace(/^FILE_/, ""));
    return {
      sym: sym,
      pretty: file,
      jumps: {
        def: file + "#1",
      },
    };
  }

  tryShowOnClick(event) {
    if (Settings.fancyBar.enabled) {
      if (this.selectedToken) {
        if (!Panel?.isOnPanel?.(event)) {
          this.selectedToken.classList.remove("selected");
          this.selectedToken = null;
          Panel?.onSelectedTokenChanged?.();
        }
      }
    }

    // Don't display the context menu if there's a selection.
    // User could be trying to select something and the context menu will undo it.
    if (!window.getSelection().isCollapsed) {
      return;
    }

    // We expect to find symbols in:
    // - source listings ("code")
    // - diagrams ("svg")
    // - breadcrumbs ("breadcrumbs")
    if (!event.target.closest("code") &&
        !event.target.closest("svg") &&
        !event.target.closest(".breadcrumbs") &&
        !event.target.closest(".symbol-tree-table")) {
      return;
    }

    let tree = document.getElementById("data").getAttribute("data-tree");

    // Figure out the source line this click was on, if it was on any line, so
    // that we can compare it against jump strings in order to avoid offering
    // the option to jump to the line the user literally just clicked on.
    let sourceLineClicked = null;
    {
      let sourceLineNode = event.target.closest("code");
      let lineNumberNode = sourceLineNode?.previousElementSibling;
      if (lineNumberNode && Router.sourcePath) {
        sourceLineClicked = `${Router.sourcePath}#${lineNumberNode.dataset.lineNumber}`;
      }
    }

    // jumps come first
    let jumpMenuItems = [];
    // then searches
    let searchMenuItems = [];
    // the the text search and sticky highlight option
    let stickyItems = [];
    // then these extra menu items which are for new/experimental features where
    // we don't want to mess with muscle memory at the top of the list.
    let extraMenuItems = [];

    let symbolToken = event.target.closest("[data-symbols]");
    if (symbolToken) {
      if (Settings.fancyBar.enabled) {
        this.selectedToken = symbolToken;
        this.selectedToken.classList.add("selected");
        Panel?.onSelectedTokenChanged?.();
      }

      const symbols = symbolToken.getAttribute("data-symbols").split(",");

      const seenSyms = new Set();
      // For debugging/investigation purposes, expose the symbols that got
      // clicked on on the window global.
      const exposeSymbolsForDebugging = window.CLICKED_SYMBOLS = [];

      // ## First pass: Process symbols and potentially filter out implicit constructors
      //
      // In the future we can potentially use this pass to do more clever things,
      // but right now the main interesting situation that can arise is that the
      // user is clicking on a constructor where we have both the constructor
      // symbol plus all of the implicit constructors that will be invoked as
      // part of the constructor and we are weirdly attributing to the constructor.
      //
      // We can detect this case because we can detect when the user is clicking
      // on a line that's already the target of a definition jump.  And then in
      // that case we can filter out all the symbols that aren't definition jumps.
      //
      // In general, we only expect to see multiple symbols here when the symbol
      // varies per platform or as a result of implicit constructors like this.
      // Our logic to remove implicit constructors here will not affect the
      // platform case because all symbols will have the line as a definition.
      // (For other platforms where the definition is on a different line, the
      // symbol won't be present here because it won't have been mered in by the
      // merge-analyses step.)
      let filteredSymPairs = [];
      let sawDef = false;
      for (const sym of symbols) {
        // Avoid processing the same symbol more than once.
        if (seenSyms.has(sym)) {
          continue;
        }

        let symInfo = SYM_INFO[sym];

        if (!symInfo) {
          if (sym.startsWith("FILE_")) {
            symInfo = this.generatePseudoFileSymInfo(sym);
          }
        }

        // XXX Ignore no_crossref data that's currently not useful/used.
        if (!symInfo || !symInfo.sym || !symInfo.pretty) {
          continue;
        }

        // The symInfo is self-identifying via `pretty` and `sym` so we don't
        // need to try and include any extra context.
        exposeSymbolsForDebugging.push(symInfo);

        if (symInfo?.jumps?.idl === sourceLineClicked ||
            symInfo?.jumps?.def === sourceLineClicked ) {
          if (!sawDef) {
            // Transition to "kick out the implicit constructors" mode.
            sawDef = true;
            filteredSymPairs = [];
          }
          filteredSymPairs.push([sym, symInfo]);
        } else if (!sawDef) {
          filteredSymPairs.push([sym, symInfo]);
        }
      }

      for (const [sym, symInfo] of filteredSymPairs) {
        let diagrammableSyms = [];
        // We need structured data to do diagramming; no structured data means
        // no diagramming.  Currently we expect this to be the case for our
        // JS analysis, but when we're able to switch at least some of the JS
        // analysis to scip-typescript that will change.
        //
        // That said, we want to ignore IDL symbols in favor of their language
        // binding symbols.  The main rationale right now is that for XPIDL
        // attributes we can't do anything for the pretty of the attribute, so
        // having a menu entry for it, especially given that we'll also have an
        // entry for the C++ getter (and potentially setter), is not helpful.
        //
        // Also, we don't currently de-duplicate the diagram links, but it
        // would be appropriate to do so or otherwise address that the traverse
        // logic itself will follow binding slots.
        if (symInfo.meta && symInfo.meta.implKind !== "idl") {
          diagrammableSyms.push(symInfo);
        }

        // Define a helper we can also use for the binding slots below.
        const jumpify = (jumpref, pretty) => {
          if (!jumpref.jumps) {
            return;
          }
          if (jumpref.jumps.idl && jumpref.jumps.idl !== sourceLineClicked) {
            jumpMenuItems.push({
              html: this.fmt("Go to IDL definition of <strong>_</strong>", pretty),
              href: `/${tree}/source/${jumpref.jumps.idl}`,
              icon: "export-alt",
              section: "jumps",
            });
          }

          if (jumpref.jumps.def && jumpref.jumps.def !== sourceLineClicked) {
            jumpMenuItems.push({
              html: this.fmt("Go to definition of <strong>_</strong>", pretty),
              href: `/${tree}/source/${jumpref.jumps.def}`,
              icon: "export-alt",
              section: "jumps",
            });
          }

          if (jumpref.jumps.decl && jumpref.jumps.decl !== sourceLineClicked) {
            jumpMenuItems.push({
              html: this.fmt("Go to declaration of <strong>_</strong>", pretty),
              href: `/${tree}/source/${jumpref.jumps.decl}`,
              icon: "export",
              section: "jumps",
            });
          }
        }

        // Helper for cases like showing the recv def when the user is clicking
        // on a call to its send, but where we don't want to crowd the context
        // menu with the decl.
        const directDefJumpify = (jumpref, pretty) => {
          if (!jumpref.jumps) {
            return;
          }

          if (jumpref.jumps.def && jumpref.jumps.def !== sourceLineClicked) {
            jumpMenuItems.push({
              html: this.fmt("Go to definition of <strong>_</strong>", pretty),
              href: `/${tree}/source/${jumpref.jumps.def}`,
              icon: "export-alt",
              section: "jumps",
            });
          }
        }

        // If the symbol has <= 2 overrides (we depend on the logic in our
        // rust `determine_desired_extra_syms_from_jumpref` helper at jumpref
        // generation time, so you can't just change the number here and have
        // things work out well), then emit direct def jump options.
        //
        // This is motivated by XPIDL where we want to be able to jump directly
        // to the overrides of the use of an XPIDL method in C++ where we are
        // dealing with an interface pointer, as well as for the binding slots
        // for when we are dealing with an XPIDL IDL def symbol.  This is
        // factored out into a helper because those are different call-sites; we
        // don't do an open-ended graph traversal.
        const overrideJumpifyHelper = (jumpref) => {
          if (jumpref.meta?.overriddenBy?.length && jumpref.meta?.overriddenBy?.length <= 2) {
            for (const overSym of jumpref.meta.overriddenBy) {
              const overInfo = SYM_INFO[overSym];
              if (overInfo) {
                let overPretty;
                if (jumpref.meta.overriddenBy.length === 1) {
                  overPretty = `Sole Override ${overInfo.pretty}`;
                } else {
                  overPretty = `Override ${overInfo.pretty}`;
                }
                directDefJumpify(overInfo, overPretty)
              }
            }
          }
        }

        let searches = [];

        // If we have a slotOwner, it can help make our "go to def" description
        // more descriptive and identical to what would be generated for when
        // the bindingSlot that refers to us from our slotOwner would describe.
        if (symInfo.meta?.slotOwner) {
          let slotOwner = symInfo.meta.slotOwner;
          let ownerJumpref = SYM_INFO[slotOwner.sym];
          // XXX Ignore no_crossref data that's currently not useful/used.
          if (ownerJumpref && ownerJumpref.sym && ownerJumpref.pretty) {
            let implKind = ownerJumpref.meta.implKind || "impl";
            if (implKind === "idl") {
              implKind = "IDL";
              // Our owner being an IDL type does not change whether this is
              // something diagrammable.
            }

            let maybeLang = "";
            if (slotOwner.slotLang) {
              maybeLang = ` ${this.fmtLang(slotOwner.slotLang)}`;
            }

            const canonLabel = `${implKind}${maybeLang} ${slotOwner.slotKind} ${symInfo.pretty}`;
            jumpify(symInfo, canonLabel);
            searches.push([ canonLabel, sym ])
            jumpify(ownerJumpref, ownerJumpref.pretty);

            // If our current symbol is an IPC Send method, offer a direct jump to the Recv def
            if (slotOwner?.slotKind === "send" && ownerJumpref) {
              for (const slot of ownerJumpref?.meta?.bindingSlots) {
                if (slot.slotKind === "recv") {
                  let recvJumpref = SYM_INFO[slot.sym];
                  if (recvJumpref?.pretty) {
                    directDefJumpify(recvJumpref, `${implKind}${maybeLang} ${slot.slotKind} ${recvJumpref.pretty}`);
                  }
                }
              }
            }
          } else {
            jumpify(symInfo, symInfo.pretty);
            searches.push([ symInfo.pretty, sym ]);
          }
        } else {
          jumpify(symInfo, symInfo.pretty);
          searches.push([ symInfo.pretty, sym ]);
        }

        // Binding slots
        if (symInfo.meta?.bindingSlots) {
          let implKind = symInfo.meta.implKind || "impl";
          if (implKind === "idl") {
            implKind = "IDL";
          }

          let allSearchSyms = [];
          for (const slot of symInfo.meta.bindingSlots) {
            // XXX Ignore no_crossref data that's currently not useful/used.
            let slotJumpref = SYM_INFO[slot.sym];
            // (we do handle the pretty not existing below)
            if (!slotJumpref || !slotJumpref.sym) {
              continue;
            }

            let maybeLang = "";
            if (slot.slotLang) {
              const lang = slot.slotLang;
              // Previously this was === "cpp", but the reality is that our
              // concern is that our JS analysis is soupy.  Especially with the
              // new TS XPIDL magic, if we can switch to scip-typescript at
              // least for system JS, we can remove this constraint.
              if (lang !== "js") {
                diagrammableSyms.push(slotJumpref);
              }
              maybeLang = ` ${this.fmtLang(lang)}`;
            }

            // Favor the slot's pretty if available.
            const effectivePretty = slotJumpref?.pretty || symInfo.pretty;
            let slotPretty =
              `${implKind}${maybeLang} ${slot.slotKind} ${effectivePretty}`;
            searches.push([slotPretty, slot.sym]);
            allSearchSyms.push(slot.sym);

            if (slotJumpref) {
              jumpify(slotJumpref, slotPretty);
              // For XPIDL, we also want to do the same overriddenBy check here
              // that we do below so that if we're browsing the XPIDL source we
              // can go directly to the implementation rather than the pure
              // virtual decl that gets upgraded to a def.  (Unfortunately we
              // currently don't have a way to easily tell that that is what
              // happened to downgrade the def, although I guess we could
              // hardcode an assumption...)
              overrideJumpifyHelper(slotJumpref);
            }
          }

          // If there were multiple language bindings that we think might exist,
          // then generate a single roll-up search.
          if (allSearchSyms.length > 1) {
            // Eat the default search if this was IDL, as currently the "search"
            // endpoint search for the synthetic symbol will only do upsells
            // which is not what people are used to.
            if (implKind === "IDL") {
              searches.shift();
              // Do put the synthetic symbol at the start of the explicit symbol
              // list, however.
              allSearchSyms.unshift(sym);
            }
            searches.push([`${implKind} ${symInfo.meta.kind} ${symInfo.pretty}`, allSearchSyms.join(",")]);
          }
        }

        overrideJumpifyHelper(symInfo);

        for (const search of searches) {
          searchMenuItems.push({
            html: this.fmt("Search for <strong>_</strong>", search[0]),
            href: `/${tree}/search?q=symbol:${encodeURIComponent(
              search[1]
            )}&redirect=false`,
            icon: "search",
            section: "symbol-searches",
          });
        }

        if (Settings.semanticInfo.enabled) {
          for (const jumpref of diagrammableSyms) {
            if ((jumpref?.meta?.kind === "class" || jumpref?.meta?.kind === "struct") &&
                jumpref?.meta?.fields?.length) {
              let queryString = `field-layout:'${jumpref.pretty}'`;
              searchMenuItems.push({
                html: this.fmt("Class layout of <strong>_</strong>", jumpref.pretty),
                href: `/${tree}/query/default?q=${encodeURIComponent(queryString)}`,
                // TODO: pick out a custom icon for this; "tasks" was great but
                // is already used for sticky highlight and so we now expect it
                // to have muscle memory implications so we can't repurpose it.
                icon: "docs",
                section: "layout",
              });
            }
          }
        }

        if (Settings.diagramming.enabled) {
          for (const jumpref of diagrammableSyms) {
            // Always offer to diagram uses of things
            let queryString = `calls-to:'${jumpref.pretty}' depth:4`;
            // TODO: Try dog-fooding with using the symbol-specific variant of this
            // whose query syntax is below.  The rationale for using pretty
            // identifiers is that they are more stable and more readable than
            // symbols.  It might be most practical to allow specializing a link
            // to just a single symbol from the page itself or in a sidebar
            // affordance, especially since it's hard to concisely express the
            // differences in signatures for overloads (although we have some
            // tentative plans to).
            //queryString = `calls-to-sym:'${jumpref.sym}' depth:4`;
            extraMenuItems.push({
              html: this.fmt("Uses diagram of <strong>_</strong>", jumpref.pretty),
              href: `/${tree}/query/default?q=${encodeURIComponent(queryString)}`,
              icon: "brush",
              section: "diagrams",
            });

            // Always offer to diagram uses of things
            queryString = `calls-from:'${jumpref.pretty}' depth:4`;
            extraMenuItems.push({
              html: this.fmt("Calls diagram of <strong>_</strong>", jumpref.pretty),
              href: `/${tree}/query/default?q=${encodeURIComponent(queryString)}`,
              icon: "brush",
              section: "diagrams",
            });

            if ((jumpref?.meta?.kind === "class" || jumpref?.meta?.kind === "struct") &&
                jumpref?.meta?.fields?.length) {
              // Offer class diagrams for classes/structs that have fields.
              queryString = `class-diagram:'${jumpref.pretty}' depth:4`;
              extraMenuItems.push({
                html: this.fmt("Class diagram of <strong>_</strong>", jumpref.pretty),
                href: `/${tree}/query/default?q=${encodeURIComponent(queryString)}`,
                icon: "brush",
                section: "diagrams",
              });
            }

            let showInheritance = false;
            if (jumpref?.meta?.kind === "method" &&
                (jumpref?.meta?.overrides?.length || jumpref?.meta?.overriddenBy?.length)) {
              showInheritance = true;
            } else if (jumpref?.meta?.kind === "class" &&
                       (jumpref?.meta?.supers?.length || jumpref?.meta?.subclasses?.length)) {
              showInheritance = true;
            }

            // Offer inheritance diagrams for methods that are involved in an
            // override hierarchy.  This does not currently work for classes
            // despite the name demanding it.  (cmd_traverse would like a minor
            // cleanup.)
            if (showInheritance) {
              queryString = `inheritance-diagram:'${jumpref.pretty}' depth:4`;
              extraMenuItems.push({
                html: this.fmt("Inheritance diagram of <strong>_</strong>", jumpref.pretty),
                href: `/${tree}/query/default?q=${encodeURIComponent(queryString)}`,
                icon: "brush",
                section: "diagrams",
              });
            }
          }
        }
      }

      const tokenText = symbolToken.textContent;
      stickyItems.push({
        html: "Sticky highlight",
        action: () => { Hover.stickyHighlight(symbols, tokenText); },
        icon: "tasks",
        section: "highlights",
      });
    }

    let menuItems = jumpMenuItems.concat(searchMenuItems);

    let word = getTargetWord();
    if (word) {
      // A word was clicked on.
      menuItems.push({
        html: this.fmt("Search for the substring <strong>_</strong>", word),
        href: `/${tree}/search?q=${encodeURIComponent(word)}&redirect=false`,
        icon: "font",
        section: "text-searches",
      });
    }

    menuItems.push(...stickyItems);

    menuItems.push(...extraMenuItems);

    if (!menuItems.length) {
      return;
    }

    let suppression = new Set();
    this.menu.innerHTML = "";
    let lastSection = null;
    for (const item of menuItems) {
      // Avoid adding anything we've definitely added before.  This currently
      // can happen for hierarchical diagrams where we unify based on the
      // "pretty" and in particular for IDL interfaces/methods where the iface
      // pretties will be the same as the C++ impl pretty.
      let itemAsJson = JSON.stringify(item);
      if (suppression.has(itemAsJson)) {
        continue;
      }
      suppression.add(itemAsJson);

      let li = document.createElement("li");
      li.classList.add("contextmenu-row")
      if (lastSection === null) {
        lastSection = item.section;
      } else if (lastSection === item.section) {
        // nothing to do for the same section
        li.classList.add("contextmenu-same-section");
      } else {
        li.classList.add("contextmenu-new-section");
        lastSection = item.section;
      }

      let link = li.appendChild(document.createElement("a"));
      if (item.action) {
        link.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          item.action();
        }, {
          // Debounce by only letting us hear one click.
          once: true
        });
        link.href = "#";
      } else if (item.href) {
        link.href = item.href;
      }

      link.classList.add("contextmenu-link");
      if (item.icon) {
        link.classList.add(`icon-${item.icon}`);
      }

      link.innerHTML = item.html;
      this.menu.appendChild(li);
    }

    let x = event.clientX + window.scrollX;
    let y = event.clientY + window.scrollY;

    let viewportHeight = window.innerHeight;
    let spaceTowardsBottom = viewportHeight - event.clientY;
    let spaceTowardsTop = viewportHeight - spaceTowardsBottom;

    // Position the menu towards the bottom, and if that overflows and there's
    // more space to the top, flip it.
    this.menu.classList.remove("bottom");
    this.menu.style.bottom = "";
    this.menu.style.top = y + "px";
    this.menu.style.left = x + "px";
    this.menu.style.maxHeight = "none";

    this.menu.style.display = "";
    this.menu.style.opacity = "0";

    let rect = this.menu.getBoundingClientRect();
    // If it overflows, either flip it or constrain its height.
    if (rect.height > spaceTowardsBottom) {
      if (spaceTowardsTop > spaceTowardsBottom) {
        // Position it towards the top.
        this.menu.classList.add("bottom");
        this.menu.style.bottom = viewportHeight - y + "px";
        this.menu.style.top = "";
        if (rect.height > spaceTowardsTop) {
          this.menu.style.maxHeight = spaceTowardsTop + "px";
        }
      } else {
        // Constrain its height.
        this.menu.style.maxHeight = spaceTowardsBottom + "px";
      }
    }

    // Now the menu is correctly positioned, show it.
    this.menu.style.opacity = "";
    this.menu.focus();
  }

  hide() {
    this.menu.style.display = "none";
  }

  get active() {
    return this.menu.style.display != "none";
  }
})();

var Hover = new (class Hover {
  constructor() {
    this.items = [];
    this.graphItems = [];
    this.hoveredElem = null;
    this.sticky = false;
    window.addEventListener("mousedown", (evt) => {
      // Constrain de-highlighting to the primary mouse button; in particular,
      // scrolling via the middle mouse button should not disable the sticky
      // state.  Unfortunately I think scrolling with the primary mouse button
      // on the modern normally-hidden scrollbars, but I'm being conservative
      // with this change.
      if (this.sticky && evt.button === 0) {
        this.deactivateDiagram();
        this.deactivate();
      }
    });

    window.addEventListener("mousemove", event => this._handleMouseMove(event));
  }

  _handleMouseMove(event) {
    if (ContextMenu.active || this.sticky) {
      return;
    }

    let elem = event.target?.closest("[data-symbols]");
    // Don't recompute things if we're still hovering over the same element.
    if (elem === this.hoveredElem) {
      return;
    }
    if (!elem) {
      this.deactivateDiagram();
      return this.deactivate();
    }

    let symbolNames = this.symbolsFromString(elem.getAttribute("data-symbols"));
    // We're hovering over a graph so we also want to hover related graph nodes.
    // We will still also potentially want to highlight any document spans as
    // well.
    if (elem.tagName === "g") {
      this.activateDiagram(elem);
    }

    this.activate(symbolNames, elem.textContent);
    this.hoveredElem = elem;
  }

  symbolsFromString(symbolStr) {
    if (!symbolStr || symbolStr == "?") {
      // XXX why the `?` special-case?
      return [];
    }
    return symbolStr.split(",");
  }

  deactivate() {
    for (let item of this.items) {
      item.classList.remove("hovered");
    }
    this.hoveredElem = null;
    this.items = [];
    this.sticky = false;
  }

  activate(symbols, visibleToken) {
    this.deactivate();
    this.items = this.findReferences(symbols, visibleToken);
    for (let item of this.items) {
      item.classList.add("hovered");
    }
  }

  findReferences(symbolNames, visibleToken) {
    if (!symbolNames.length) {
      return [];
    }

    let symbols = new Set(symbolNames);

    return [...document.querySelectorAll("span[data-symbols]")].filter(span => {
      // XXX The attribute check is cheaper, probably should be before.
      return (
        span.textContent == visibleToken &&
        this.symbolsFromString(span.getAttribute("data-symbols")).some(symbol =>
          symbols.has(symbol)
        )
      );
    });
  }

  activateDiagram(elem) {
    this.deactivateDiagram();

    let id;
    if (elem.id) {
      id = elem.id;
    } else {
      id = elem.parentElement.id;
    }
    if (id.startsWith("a_")) {
      id = id.substring(2);
    }
    let nodeExtra = GRAPH_EXTRA[0].nodes[id];
    if (!nodeExtra) {
      return;
    }

    const applyStyling = (targetId, clazzes) => {
      let maybeTarget = document.getElementById(targetId);
      // For the table rows, the id ends up on a "g" container with an "a_"
      // prefix.  We want to locate the a_ prefix and then adjust to its sole
      // child for consistency.
      if (!maybeTarget) {
        maybeTarget = document.getElementById(`a_${targetId}`);
        if (!maybeTarget) {
          return;
        }
        maybeTarget = maybeTarget.children[0];
      }
      maybeTarget.classList.add(...clazzes);

      this.graphItems.push([maybeTarget, clazzes])
    };

    const curNodeHover = ["hovered-cur-node"];
    elem.classList.add(...curNodeHover);
    this.graphItems.push([elem, curNodeHover]);

    const defaultInNodeHover = ["hovered-in-node"];
    for (const [nid, clazzes] of nodeExtra.in_nodes) {
      applyStyling(nid, clazzes.length ? clazzes : defaultInNodeHover);
    }
    const defaultOutNodeHover = ["hovered-out-node"];
    for (const [nid, clazzes] of nodeExtra.out_nodes) {
      applyStyling(nid, clazzes.length ? clazzes : defaultOutNodeHover);
    }

    const inEdgeHover = ["hovered-in-edge"];
    for (const eid of nodeExtra.in_edges) {
      applyStyling(eid, inEdgeHover);
    }

    const outEdgeHover = ["hovered-out-edge"];
    for (const eid of nodeExtra.out_edges) {
      applyStyling(eid, outEdgeHover);
    }
  }

  deactivateDiagram() {
    for (const [item, clazzes] of this.graphItems) {
      item.classList.remove(...clazzes);
    }
    this.graphItems = [];
  }

  stickyHighlight(symbols, visibleToken) {
    ContextMenu.hide();
    this.activate(symbols, visibleToken);
    this.sticky = true;
  }
})();

function getTargetWord() {
  let selection = window.getSelection();
  if (!selection.isCollapsed) {
    return null;
  }

  let offset = selection.focusOffset;
  let node = selection.anchorNode;
  let string = node?.nodeValue;

  if (!string?.length) {
    return null;
  }

  function isWordChar(character) {
    // TODO: this could be more non-ascii friendly.
    //
    // Notable Changes:
    // - We have added "#" to deal with JS private symbols.  This will widen
    //   C preprocessor directives to include the leading #, which makes sense.
    //   This will also impact use of the "stringizing operator" for macros,
    //   where it won't be what we want.
    return /[#A-Z0-9_]/i.test(character);
  }

  if (offset < string.length && !isWordChar(string[offset])) {
    // Not really in a word.
    return null;
  }

  let start = offset;
  let end = offset;

  while (start > 0 && isWordChar(string[start - 1])) {
    --start;
  }
  while (end < string.length && isWordChar(string[end])) {
    ++end;
  }

  if (end <= start) {
    return null;
  }

  return string.substring(start, end);
}
