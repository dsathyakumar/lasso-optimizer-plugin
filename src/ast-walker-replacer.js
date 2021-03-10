/* eslint-disable max-len */
/* eslint-disable no-console */
'use strict';

const { get } = require('@ebay/retriever');
const traverse = require('@babel/traverse');
const types = require('@babel/types');
const {
    isLassoModule,
    isRootFuncExpression,
    pruneReferencePaths
} = require('./utils');

const getPathToVarRef = (moduleNameAndPath, argsZero, meta) => {
    if (!moduleNameAndPath || !argsZero || !meta) {
        throw new Error(`All args to be present for getPathToVarRef()`);
    }
    // from the finalized list, get what this path maps to
    // For eg) require('/marko$4.20.1/dist/components/runtime')
    let pathToVariableRef =
        meta.def[moduleNameAndPath].dependencies.finalize[argsZero.value];

    // ideally it should have been resolved already. Else throw
    if (!pathToVariableRef) {
        throw new Error(`Unresolved dependency ${moduleNameAndPath}`);
    }

    console.info(
        // eslint-disable-next-line max-len
        `Replaced require('${argsZero.value}') with require(${pathToVariableRef.altid})`
    );

    return {
        altid: pathToVariableRef.altid,
        modulePathToVarRef: pathToVariableRef.modulePathToVarRef
    };
};

const walkForDependencies = (traversalPath, meta, moduleNameAndPath) => {
    const paramBindings = traversalPath.scope.getAllBindingsOfKind('param');
    const paramsNodes = traversalPath.node.params;

    // require, exports, module, __filename, __dirname in this order
    const paramNames = paramsNodes.map(node => node.name);
    Object.keys(paramBindings).forEach(paramBindingName => {
        if (traversalPath.scope.hasOwnBinding(paramBindingName)) {
            if (
                paramBindings[paramBindingName].referenced &&
                paramBindings[paramBindingName].references > 0
            ) {
                // in minified output, we cannot find the names
                // we are basically checking dependencies via .require
                if (
                    paramBindings[paramBindingName].identifier.name ===
                    paramNames[0]
                ) {
                    let referencedPaths =
                        paramBindings[paramBindingName].referencePaths;

                    // we want to prune out all those references used after a variable that represents
                    // a "require" call is re-assigned.
                    if (!paramBindings[paramBindingName].constant) {
                        console.warn(
                            `If using minified output, var representing "require" may be re-assigned
                            by Terser/Uglify. Lasso-optimizer attempts to prune away such re-assigned paths,
                            so that they don't result in false "require" types. Starting pruning...`
                        );
                        console.warn(
                            `Number of B4 = ${referencedPaths.length}`
                        );
                        referencedPaths = pruneReferencePaths(
                            referencedPaths,
                            paramBindings[paramBindingName].constantViolations,
                            moduleNameAndPath
                        );
                        console.warn(
                            `Number After = ${referencedPaths.length}`
                        );
                    }

                    referencedPaths.forEach(refPath => {
                        const refPathNode = refPath.node;

                        if (types.isIdentifier(refPathNode)) {
                            const refPathNodeParent = refPath.parent;

                            if (types.isCallExpression(refPathNodeParent)) {
                                const callee = refPathNodeParent.callee;

                                // a require call is an identifier
                                if (types.isIdentifier(callee)) {
                                    // check if its the arg we are looking for
                                    if (
                                        callee.name ===
                                        paramBindings[paramBindingName]
                                            .identifier.name
                                    ) {
                                        // This should have only 1 argument accessed at arguments[0]
                                        // as a require call has only 1 arg
                                        const argsZero =
                                            refPathNodeParent.arguments[0];

                                        // check if its a String based path and if there's only 1 argument
                                        // These are the types we can resolve.
                                        // Dynamic require's cannot be resolved by us.
                                        if (
                                            types.isStringLiteral(argsZero) &&
                                            refPathNodeParent.arguments
                                                .length === 1
                                        ) {
                                            const pathToVariableRef = getPathToVarRef(
                                                moduleNameAndPath,
                                                argsZero,
                                                meta
                                            );

                                            refPathNodeParent.arguments.pop();
                                            refPath.addComment(
                                                'leading',
                                                `id: ${pathToVariableRef.altid}, module: ${pathToVariableRef.modulePathToVarRef}`
                                            );
                                            // replace the require path with get(numeriliteral).
                                            refPathNodeParent.arguments.push(
                                                types.callExpression(
                                                    types.identifier('___$_get'),
                                                    [
                                                        types.numericLiteral(
                                                            pathToVariableRef.altid
                                                        )
                                                    ]
                                                )
                                            );
                                        } else {
                                            // thsi could be an identifier or a member expression or even
                                            // a function expression that returns a value. NO idea!
                                            if (
                                                !types.isStringLiteral(argsZero)
                                            ) {
                                                console.warn(`
                                                    Possible Dynamic Require() -> "${argsZero.name}" at ${moduleNameAndPath}`);
                                            }
                                        }
                                    }
                                } else {
                                    // log
                                    console.warn('unknown type of require');
                                }
                            } else if (
                                types.isMemberExpression(refPathNodeParent)
                            ) {
                                // check if its of type .resolve
                                if (
                                    refPathNodeParent.object.name ===
                                        paramBindings[paramBindingName]
                                            .identifier.name &&
                                    refPathNodeParent.property.name ===
                                        'resolve'
                                ) {
                                    const parentCallExprPath =
                                        refPath.parentPath.parentPath;
                                    const argsZero =
                                        parentCallExprPath.node.arguments[0];

                                    // this is a static require.resolve()
                                    if (
                                        types.isStringLiteral(argsZero) &&
                                        parentCallExprPath.node.arguments
                                            .length === 1
                                    ) {
                                        let identifierName = '';

                                        // else if it resolves to a Function Expression
                                        identifierName = getPathToVarRef(
                                            moduleNameAndPath,
                                            argsZero,
                                            meta
                                        );
                                        parentCallExprPath.node.arguments.pop();
                                        refPath.addComment(
                                            'leading',
                                            `id: ${identifierName.altid}, module: ${identifierName.modulePathToVarRef}`
                                        );

                                        if (!identifierName.altid) {
                                            throw new Error(
                                                `${moduleNameAndPath} not resolved in require()`
                                            );
                                        }

                                        // here it should be replaced by a MemberExpression of
                                        // identifierName.name
                                        // Fr eg) require.resolve(__webresourcejs_1_0_1__dist__file.name);
                                        // Runtime, __webresourcejs_1_0_1__dist__file.name will resolve
                                        // to a string of the function declaration name
                                        parentCallExprPath.node.arguments.push(
                                            types.callExpression(
                                                types.identifier('___$_get'),
                                                [
                                                    types.numericLiteral(
                                                        identifierName.altid
                                                    )
                                                ]
                                            )
                                        );
                                    } else {
                                        // mostly a dynamic require
                                        if (
                                            !types.isStringLiteral(argsZero) &&
                                            parentCallExprPath.node.arguments
                                                .length === 1
                                        ) {
                                            console.warn(
                                                'This is a dynamic .resolve()'
                                            );
                                        }
                                    }
                                } else {
                                    console.warn(
                                        'Not of type require.resolve()'
                                    );
                                }
                            } else {
                                console.error('Unknow type');
                            }
                        } else {
                            console.error('ERR!!!! Unknown type');
                        }
                    });
                }
            }
        }
    });
};

const fixDependencies = (moduleNameAndPath, path, meta) => {
    if (moduleNameAndPath && path) {
        path.traverse({
            FunctionExpression(traversalPath) {
                if (isRootFuncExpression(traversalPath)) {
                    try {
                        // if (moduleNameAndPath === '/marko$4.15.0/dist/components/dom-data') {
                        // debugger;
                        // }
                        walkForDependencies(
                            traversalPath,
                            meta,
                            moduleNameAndPath
                        );
                    } catch (e) {
                        console.error(e.message);
                    } finally {
                        // cos for a given Lasso Module, we know there is only one root CallExpression
                        // which has only 1 root FuncExpression
                        traversalPath.stop();
                    }
                }
            }
        });
    }

    return;
};

const getLassoModulesDataAndDefs = (path, meta) => {
    const data = {};

    if (path) {
        const calleeObj = get(path, 'node.callee', {});
        const lassoModuleType = get(calleeObj, 'property.name', '');
        const args = get(path, 'node.arguments', []);

        data.type = lassoModuleType;

        if (lassoModuleType === 'def') {
            if (types.isStringLiteral(args[0])) {
                data.path = args[0].value;
                if (types.isFunctionExpression(args[1])) {
                    console.info(`Def for ${args[0].value}`);
                    // fix required dependencies within the functionExpression
                    // These dependencies have already been resolved.
                    // we ultimately need the params list and func body
                    // so that the func expression can be transformed to a func declaration
                    // and we only need to fix dependencies if they existed (if a require call existed)
                    // same way with require.resolve()
                    // also note that only static require calls will be a part of deps and resolve
                    // if there was a module that had only dynamic calls, then it wont be listed here
                    // and this block wont even execute.
                    if (
                        meta.def[args[0].value].dependencies.deps.length ||
                        meta.def[args[0].value].dependencies.resolve.length
                    ) {
                        console.info(
                            `Fixing deps & resolvables for ${args[0].value}`
                        );
                        fixDependencies(args[0].value, path, meta);
                    }
                    data.defParams = args[1].params;
                    data.defBodyDefn = args[1].body;
                } else if (types.isObjectExpression(args[1])) {
                    // This is when a JSON file is part of the require.
                    data.objExpr = args[1];
                }

                // when globals are set in define. For eg) jQuery
                if (args[2] && types.isObjectExpression(args[2])) {
                    if (args[2].properties.length === 1) {
                        const property = args[2].properties[0];
                        if (
                            types.isIdentifier(property.key) &&
                            property.key.name === 'globals'
                        ) {
                            if (types.isArrayExpression(property.value)) {
                                data.globals = args[2];
                            }
                        }
                    }
                }
            }
        } else if (lassoModuleType === 'remap') {
            // $_mod.remap("/marko$4.15.0/components", "/marko$4.15.0/components-browser.marko");
            if (
                types.isStringLiteral(args[0]) &&
                types.isStringLiteral(args[1])
            ) {
                data.from = args[0].value;
                data.to = args[1].value;
            }
        } else if (lassoModuleType === 'run') {
            /** Fr eg)
             *  $_mod.run("/raptor-amd$1.1.8/lib/init", {
                    wait: !1
                });
                */
            if (types.isStringLiteral(args[0])) {
                data.path = args[0].value;

                if (types.isObjectExpression(args[1])) {
                    // could either be options.wait
                    data.runOptions = args[1];
                } else if (types.isStringLiteral(args[1])) {
                    // or a path to another module that has to be resolved.
                    data.runOptions = args[1].value;
                }
            }
        } else if (lassoModuleType === 'main') {
            // For eg) $_mod.main("/i18n-ebay$4.0.3", "lib/index");
            // If the main file path is empty, it defaults to Node's standard protocal of /index
            if (
                types.isStringLiteral(args[0]) &&
                types.isStringLiteral(args[1])
            ) {
                data.modulePath = args[0].value;
                data.mainFilePath = args[1].value;
            }
        } else if (lassoModuleType === 'installed') {
            // For eg) $_mod.installed("i18n-ebay$4.0.3", "raptor-util", "1.1.2");
            if (
                types.isStringLiteral(args[0]) &&
                types.isStringLiteral(args[1]) &&
                types.isStringLiteral(args[2])
            ) {
                data.bundleName = args[0].value;
                data.moduleName = args[1].value;
                data.version = args[2].value;
            }
        } else if (lassoModuleType === 'searchPath') {
            // For eg) $_mod_gh_fe.searchPath("/globalheaderfrontend$37.0.0/"),
            if (types.isStringLiteral(args[0])) {
                data.searchPath = args[0].value;
            }
        } else if (lassoModuleType === 'builtin') {
            // For eg) $_mod.builtin("lasso-loader", "/lasso-loader$3.0.2/src/index");
            if (
                types.isStringLiteral(args[0]) &&
                types.isStringLiteral(args[1])
            ) {
                data.moduleName = args[0].value;
                data.mainFilePath = args[1].value;
            }
        } else if (lassoModuleType === 'loaderMetadata') {
            /** For eg) *
             * $_mod.loaderMetadata({
                    "onboarding-dialog-large": {
                        css: ["https://ir.ebaystatic.com/rs/c/highlnfe-async-ti9Bv3J-.css"],
                        js: ["https://ir.ebaystatic.com/rs/c/highlnfe-async-3CzT5n7D.js"]
                    },
                    "onboarding-dialog-small": {},
                    _eedb99: {
                        css: ["https://ir.ebaystatic.com/rs/c/highlnfe-async-ti9Bv3J-.css"],
                        js: ["https://ir.ebaystatic.com/rs/c/highlnfe-async-3CzT5n7D.js"]
                    },
                    _16556d: {
                        css: ["https://ir.ebaystatic.com/rs/c/highlnfe-async-ti9Bv3J-.css"],
                        js: ["https://ir.ebaystatic.com/rs/c/highlnfe-async-3CzT5n7D.js"]
                    }
                });
                */
            // do nothing. The loaderMetadata info is already collected
        }
    }

    return data;
};

const traverseExpressionStatement = (exprStatementPathNode, meta) => {
    let isLassoModuleType = false;
    let data = null;

    if (exprStatementPathNode) {
        exprStatementPathNode.traverse({
            CallExpression: {
                enter(traversalPath) {
                    if (isLassoModule(traversalPath)) {
                        isLassoModuleType = true;
                        data = getLassoModulesDataAndDefs(traversalPath, meta);
                        traversalPath.stop();
                    }
                }
            }
        });
    }

    return {
        isLassoModuleType,
        data
    };
};

const walkAstAndReplace = (ast, dependencyPathToVarName, noconflict, meta) => {
    if (ast) {
        traverse.default(ast, {
            enter(traversalPath) {
                if (types.isExpressionStatement(traversalPath.node)) {
                    const {
                        isLassoModuleType,
                        data
                    } = traverseExpressionStatement(traversalPath, meta);

                    if (isLassoModuleType) {
                        // here since we are collecting info, we are only interested in Lasso Modules
                        // and not the lasso-moudles-client runtime.
                        const {
                            globals,
                            type,
                            path,
                            from,
                            objExpr,
                            defParams,
                            defBodyDefn,
                            modulePath,
                            bundleName,
                            moduleName,
                            version,
                            searchPath
                        } = data;

                        let { runOptions } = data;

                        if (type === 'def') {
                            console.info(`Replacing Def for ${path}`);
                            let modulePathToVarRef =
                                (dependencyPathToVarName[path] &&
                                    dependencyPathToVarName[path]
                                        .modulePathToVarRef) ||
                                meta.def[path].modulePathToVarRef;
                            
                            let altid =
                                (dependencyPathToVarName[path] &&
                                    dependencyPathToVarName[path]
                                        .altid) ||
                                meta.def[path].altid;

                            if (!modulePathToVarRef) {
                                throw new Error(
                                    `Ast-modification failed. ${path} missing modulePathToVarRef`
                                );
                            }

                            if (typeof altid === 'undefined') {
                                throw new Error(
                                    `Ast-modification failed. ${path} missing altid`
                                );
                            }

                            // when its a factory function
                            if (defParams && defBodyDefn) {
                                traversalPath.addComment(
                                    'leading',
                                    // eslint-disable-next-line max-len
                                    `id = ${altid}. Removing type: ${type} of ${path}. Replaced with function declaration ${modulePathToVarRef}`
                                );

                                const args = [
                                    types.functionExpression(
                                        types.identifier(modulePathToVarRef),
                                        defParams,
                                        defBodyDefn
                                    )
                                ];

                                if (globals) {
                                    args.push(globals);
                                }

                                // this basically set the scope bridge
                                traversalPath.replaceWithMultiple([
                                    types.expressionStatement(
                                        types.CallExpression(
                                            types.identifier('___$_set'),
                                            args
                                        )
                                    )
                                ]);
                            } else if (objExpr) {
                                traversalPath.addComment(
                                    'leading',
                                    // eslint-disable-next-line max-len
                                    `id = ${altid}, Removing type: ${type} of ${path}. Replaced with variable declaration ${modulePathToVarRef}`
                                );
                                // when its an object expression
                                // say when a JSON file is required.
                                // even this we store with the modulePathToVarRef, but a require to this
                                // will also pass the refID, so we check for refID above. Cos, this cannot be
                                // accessed as func.name & there is no way to get the name of the variable Identifier
                                const varDeclaration = types.variableDeclaration(
                                    'var',
                                    [
                                        types.variableDeclarator(
                                            types.identifier(
                                                modulePathToVarRef
                                            ),
                                            objExpr
                                        )
                                    ]
                                );
                                traversalPath.replaceWithMultiple([
                                    varDeclaration,
                                    types.expressionStatement(
                                        types.CallExpression(
                                            types.identifier('___$_set'),
                                            [
                                                types.identifier(
                                                    modulePathToVarRef
                                                )
                                            ]
                                        )
                                    )
                                ]);
                            } else {
                                console.warn('No idea what .def this is');
                            }
                        } else if (type === 'main') {
                            traversalPath.parentPath.addComment(
                                'leading',
                                `Removing type: ${type} of ${modulePath}`
                            );
                            traversalPath.remove();
                        } else if (type === 'installed') {
                            traversalPath.parentPath.addComment(
                                'leading',
                                `Removing type: ${type} of ${moduleName} with v${version} installed in ${bundleName}`
                            );
                            traversalPath.remove();
                        } else if (type === 'remap') {
                            traversalPath.parentPath.addComment(
                                'leading',
                                `Removing type: ${type} of ${from}`
                            );
                            traversalPath.remove();
                        } else if (type === 'builtin') {
                            traversalPath.parentPath.addComment(
                                'leading',
                                `Removing type: ${type} of ${moduleName}`
                            );
                            traversalPath.remove();
                        } else if (type === 'run') {
                            let altid =
                                (dependencyPathToVarName[path] &&
                                    dependencyPathToVarName[path].altid) ||
                                meta.def[path].altid;
                            let modulePathToVarRef =
                                (dependencyPathToVarName[path] &&
                                    dependencyPathToVarName[path]
                                        .modulePathToVarRef) ||
                                meta.def[path].modulePathToVarRef;

                            traversalPath.addComment(
                                'leading',
                                `Removing type: ${type} of ${path}. Self-invocation injected for id=${altid} of ${modulePathToVarRef}`
                            );

                            // if not a string, by default runOption is an ObjectExpression
                            // with a wait property set.
                            if (typeof runOptions === 'string') {
                                // this is a path & has to be resolved
                                const optionalAltId =
                                    (dependencyPathToVarName[runOptions] &&
                                        dependencyPathToVarName[runOptions]
                                            .altid) ||
                                    meta.def[runOptions].altid;
                                // it has to be an identifier
                                runOptions = types.callExpression(
                                    types.identifier('___$_get'),
                                    [types.numericLiteral(optionalAltId)]
                                );
                            }

                            const callExprArgs = [
                                types.callExpression(types.identifier('___$_get'), [
                                    types.numericLiteral(altid)
                                ])
                            ];

                            // if it was an obj expression, send it by default
                            if (typeof runOptions !== 'undefined') {
                                callExprArgs.push(runOptions);
                            }

                            // replace function expr to func decl here.
                            traversalPath.replaceWith(
                                types.expressionStatement(
                                    types.callExpression(
                                        types.identifier('___$_run'),
                                        callExprArgs
                                    )
                                )
                            );
                        } else if (type === 'searchPath') {
                            traversalPath.parentPath.addComment(
                                'leading',
                                `Removing type: ${type} of ${searchPath}`
                            );
                            traversalPath.remove();
                        } else if (type === 'loaderMetadata') {
                            traversalPath.parentPath.addComment(
                                'leading',
                                `Retaining type: ${type} of ${JSON.stringify(
                                    meta.loaderMetadata
                                )}`
                            );
                        }

                        traversalPath.skip();
                    }
                }
            }
        });
    }
    return ast;
};

exports.walkAstAndReplace = walkAstAndReplace;
