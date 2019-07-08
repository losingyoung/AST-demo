const parser = require("@babel/parser")
const template = require("@babel/template").default;
const traverse = require("@babel/traverse").default
const t = require("@babel/types")
const generator = require("@babel/generator").default
const path = require('path')
const fs = require('fs')
const { decryptStr, decryptStrFnName } = require('./module')

// 需手动删除最上面的无用代码
step1().then(step2) 
function step1() {
    return new Promise((resolve, reject) => {
        fs.readFile(path.resolve(__dirname, './source.js'), { "encoding": 'utf-8' }, function (err, data) {
            const ast = parser.parse(data)
            decrypt(ast)
            let { code } = generator(ast)
            code = code.replace(/!!\[\]/g, 'true').replace(/!\[\]/g, 'false')
            fs.writeFile(path.resolve(__dirname, './result1.js'), code, function (err) {
                if (!err) {
                    console.log('result1 generated')
                    resolve()
                } else {
                    console.log(err)
                    reject()
                }
            })
        })
    })

}
// step2
function step2() {
    fs.readFile(path.resolve(__dirname, './result1.js'), { "encoding": 'utf-8' }, function (err, data) {
        const ast = parser.parse(data)
        decrypt2(ast)
        let { code } = generator(ast)
        code = code.replace(/!!\[\]/g, 'true').replace(/!\[\]/g, 'false')
        fs.writeFile(path.resolve(__dirname, './result2.js'), code, function (err) {
            if (!err) {
                console.log('finished')
            } else {
                console.log(err)
            }
        })
    })
}

function decrypt(ast) {
    traverse(ast, {
        StringLiteral: {//step1
            enter: [removeExtra]
        },
        NumericLiteral: removeExtra,
        CallExpression: {//step1
            enter: [callToStr]
        }
    })

}
// step2
function decrypt2(ast) {
    traverse(ast, {
        CallExpression: {//step1
            exit: [replaceMainArgs] // 因为要等下面两个转换完，所以我们放在exit中
        },
        WhileStatement: replaceWhile,
        VariableDeclarator: {
            enter: [replaceFns]
        }
        // Identifier: {
        //     enter: [renameVars]
        // },

    })
}
function removeExtra(path) {
    delete path.node.extra
}
// 替换变量名
function renameVars(path) {
    let val = path.node.name
    if (val in renameVarMap) {
        path.scope.rename(val, renameVarMap[val])
        return
    }
    const vals = Object.values(renameVarMap)
    if (vals.includes(val)) return
    let newName = path.scope.generateUid(randomVarName())

    path.scope.rename(val, newName)
}
function randomVarName() {
    var names = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmopqrstuvwxyz'
    return names[Math.floor(Math.random() * 51)]
}
function replaceFns(path) {
    let node = path.node
    if (!t.isObjectExpression(node.init)) return
    let properties = node.init.properties
    try {
        if (!t.isFunctionExpression(properties[0].value)) return
        if (properties[0].value.body.body.length !== 1) return
        let retStmt = properties[0].value.body.body[0]
        if (!t.isReturnStatement(retStmt)) return

    } catch (error) {
        // console.log('ignore: wrong fn arr', properties)
    }

    let objName = node.id.name
    properties.forEach(prop => {
        let key = prop.key.value
        let params = prop.value.params
        let retStmt = prop.value.body.body[0] // 替换体

        const fnPath = path.getFunctionParent()
        fnPath.traverse({
            CallExpression: function (_path) {
                if (!t.isMemberExpression(_path.node.callee)) return
                let node = _path.node.callee
                if (!t.isIdentifier(node.object) || node.object.name !== objName) return

                if (!t.isStringLiteral(node.property) || node.property.value !== key) return
                let args = _path.node.arguments // 调用传入的参数

                if (t.isBinaryExpression(retStmt.argument) && args.length === 2) {
                    _path.replaceWith(t.binaryExpression(retStmt.argument.operator, args[0], args[1]))
                }
                if (t.isLogicalExpression(retStmt.argument) && args.length === 2) {
                    _path.replaceWith(t.logicalExpression(retStmt.argument.operator, args[0], args[1]))
                }
                if (t.isCallExpression(retStmt.argument) && t.isIdentifier(retStmt.argument.callee)) {
                    _path.replaceWith(t.callExpression(args[0], args.slice(1)))
                }
            }
        })
    })
    path.remove()



}

function callToStr(path) {
    let node = path.node
    if (t.isIdentifier(node.callee) && node.callee.name === decryptStrFnName) {
        const result = decryptStr(node.arguments[0].value)
        path.replaceWith(t.stringLiteral(result))
        return
    }
}
function replaceMainArgs(path) {
    let node = path.node
    // 自执行函数
    if (t.isFunctionExpression(node.callee)) {
        // 里面的
        if (node.arguments.length < 10) return
        let filePath = './transfer.js'
        generateTransferFile(path, filePath)
        const argNames = node.callee.params.map(a => a.name)
        const transferArgs = require(filePath)
        let newArgs = transferArgs(...node.arguments)
        path.traverse({
            Identifier(path) {
                let argIdx = argNames.indexOf(path.node.name)
                if (argIdx > -1) {
                    let newValue = newArgs[argIdx]
                    path.replaceWith(newValue)
                }
            }
        })
        const inner = path.get('callee.body.body.0')
        path.replaceWith(inner)
        // debugger
    }
}
function generateTransferFile(path, filePath) {
    let node = path.node
    const argValues = node.arguments
    const paramIdentifiers = node.callee.params.map(n => n.name)
    let argVarNode
    path.traverse({
        enter: function (_path) {
            if (_path.node.name === 'arguments') {
                const varPath = _path.find(parentPath => {
                    return parentPath.isVariableDeclarator()
                })
                if (varPath) {
                    argVarNode = varPath.node.id
                    _path.stop()
                }

            }
        }
    })
    // node.callee.body是BlockStatement, node.callee.body.body是函数体, 由于最后一个是内部的自执行函数，我们先去掉
    const body = node.callee.body.body.slice(0, node.callee.body.body.length - 1)
    const mainBody = node.callee.body.body[node.callee.body.body.length - 1]

    const retStatement = t.returnStatement(argVarNode)
    const fn = t.functionDeclaration(t.identifier('transfer'), [], t.blockStatement(body.concat(retStatement)))
    // 因为需要生成一个完整的js，所以我们要补上最外面的program节点

    const program = t.file(t.program([fn, template.ast('module.exports = transfer')]))

    traverse(program, {
        Identifier: {
            enter: (path) => {
                const node = path.node
                const idIdx = paramIdentifiers.indexOf(node.name)
                if (idIdx > -1) {
                    let valueNode = argValues[idIdx]
                    path.replaceWith(valueNode)
                }
            }
        },
        StringLiteral: {
            exit: path => {
                const node = path.node
                if (node.value === 'string') {
                    node.value = 'StringLiteral'
                    const ifStatement = path.find(p => p.isIfStatement())
                    let ifTestMemberExpression
                    ifStatement.traverse({
                        MemberExpression({ node }) {
                            ifTestMemberExpression = node
                        },
                        UnaryExpression(path) {
                            if (path.node.operator === 'typeof') {
                                path.replaceWith(t.memberExpression(path.node.argument, t.identifier("type")))
                            }
                        }
                    })
                    let left = ifTestMemberExpression.object.name
                    let right = ifTestMemberExpression.property.name
                    const consequent = ifStatement.get('consequent')
                    consequent.traverse({
                        MemberExpression(path) {
                            let { object, property } = path.node
                            if (object.name === left && property.name === right) {
                                path.replaceWith(t.memberExpression(path.node, t.identifier('value')))
                                path.skip()
                            }
                        }
                    })
                }
            }
        }
    })

    let { code } = generator(program)
    path.get('callee.body').replaceWith(t.blockStatement([mainBody]))
    fs.writeFileSync(filePath, code, { encoding: 'utf-8' })
}

function replaceWhile(path) {
    let node = path.node

    if (!t.isBooleanLiteral(node.test) || node.test.value !== true) return
    if (!t.isBlockStatement(node.body)) return
    const body = node.body.body
    if (!t.isSwitchStatement(body[0]) || !t.isMemberExpression(body[0].discriminant) || !t.isBreakStatement(body[1])) return

    const switchStm = body[0]
    const arrName = switchStm['discriminant'].object.name


    let varKey = path.key - 1
    let varPath = path.getSibling(varKey)
    let varNode = varPath.node.declarations.filter(declarator => declarator.id.name === arrName)[0]
    let idxArr = varNode.init.callee.object.value.split('|')

    const runBody = switchStm.cases
    let retBody = []
    idxArr.map(targetIdx => {
        let targetBody = runBody[targetIdx].consequent
        if (t.isContinueStatement(targetBody[targetBody.length - 1])) {
            targetBody.pop()
        }
        retBody = retBody.concat(targetBody)
    })
    path.replaceWithMultiple(retBody)
    varPath.remove()
}