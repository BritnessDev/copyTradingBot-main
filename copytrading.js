import http from 'http'
import ethers, { BigNumber } from 'ethers'
import express from 'express'
import expressWs from 'express-ws'
import fs from 'fs'
import chalk from 'chalk'
import path from 'path'
import { fileURLToPath } from 'url'
import BlocknativeSDK from 'bnc-sdk'
import WebSocket from 'ws'

import data from './config.js'

const app = express()
const httpServer = http.createServer(app)
const wss = expressWs(app, httpServer)


let configuration = JSON.parse(fs.readFileSync('configuration.json', 'utf-8'))
let uniswapV2ABI = JSON.parse(fs.readFileSync('uniswapV2Router.json', 'utf-8'))

var botStatus = false
var isStarted = false
var provider
var wallet
var account
var router
var buy_tx
var isBuy = false
var prevtx = []
var count = 0

const ERC20_ABI = [
  {
    constant: false,
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: 'success', type: 'bool' }],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: 'supply', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_from', type: 'address' },
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ name: 'success', type: 'bool' }],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: 'digits', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: 'success', type: 'bool' }],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: 'remaining', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: '_owner', type: 'address' },
      { indexed: true, name: '_spender', type: 'address' },
      { indexed: false, name: '_value', type: 'uint256' },
    ],
    name: 'Approval',
    type: 'event',
  },
]

async function sdkSetup(sdk, configuration) {
  const parsedConfiguration = typeof configuration === 'string' ? JSON.parse(configuration) : configuration
  const globalConfiguration = parsedConfiguration.find(({ id }) => id === 'global')
  const addressConfigurations = parsedConfiguration.filter(({ id }) => id !== 'global')

  // save global configuration first and wait for it to be saved
  globalConfiguration && await sdk.configuration({scope: 'global', filters: globalConfiguration.filters})

  addressConfigurations.forEach(({id, filters, abi}) => {
    const abiObj = abi ? { abi } : {}
    sdk.configuration({...abiObj, filters, scope: id, watchAddress: true})
  })
}

// Function name and hash pairs
const functionName = {
  "0x18cbafe5" : "swapExactTokensForETH",
  "0x38ed1739" : "swapExactTokensForTokens",
  "0x4a25d94a" : "swapTokensForExactETH",
  "0x5c11d795" : "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  "0x791ac947" : "swapExactTokensForETHSupportingFeeOnTransferTokens",
  "0x7ff36ab5" : "swapExactETHForTokens",
  "0x8803dbee" : "swapTokensForExactTokens",
  "0xb6f9de95" : "swapExactETHForTokensSupportingFeeOnTransferTokens",
  "0xfb3bdb41" : "swapETHForExactTokens"
}
function transactionDecode(tx) {
  let transaction = tx.input
  let txFunc = transaction.substring(0, 10)
  let value = {}
  let address = []
  value.flag = 0
  if(txFunc == "0x18cbafe5" ||
    txFunc == "0x38ed1739" ||
    txFunc == "0x4a25d94a" ||
    txFunc == "0x5c11d795" ||
    txFunc == "0x791ac947" ||
    txFunc == "0x8803dbee")
    {
      value.flag = 1
      let hex = transaction.substring(74,138)
      var bn = BigInt('0x' + hex)
      value.amountOutMin = bn.toString(10)
      hex = transaction.substring(10,74)
      bn = BigInt('0x' + hex);
      value.amountIn = bn.toString(10);
      value.deadline = parseInt(transaction.substring(266,330))
      let len = parseInt(transaction.substring(330,394))
      for(let i = 1; i <= len; i++)
        address[i-1] = '0x' + transaction.substring(354 + i*64, 394 + i*64)
      value.len = len
      value.path = address
      value.name = functionName[txFunc]
    }
  if(txFunc == "0x7ff36ab5" ||
    txFunc == "0xb6f9de95" ||
    txFunc == "0xfb3bdb41")
    {
      value.flag = 2
      let hex = transaction.substring(10,74)
      var bn = BigInt('0x' + hex);
      value.amountIn = tx.value;
      value.amountOutMin = bn.toString(10);
      value.deadline = parseInt(transaction.substring(202,266))
      let len = parseInt(transaction.substring(266,330))
      for(let i = 1; i <= len; i++)
        address[i-1] = '0x' + transaction.substring(290 + i*64, 330 + i*64)
      value.len = len
      value.path = address
      value.name = functionName[txFunc]
    }
    return value
}

/////////////////////////////////////////////////////////////////////////////////////////////////////
//    This Part is really important.
/////////////////////////////////////////////////////////////////////////////////////////////////////

async function handleTransactionEvent(transaction) {
  if(!isBuy && botStatus){
    try{
      isBuy = true;
      let tx = transaction.transaction

      // Get parameters from Input field 
      let value = transactionDecode(tx)

      // To prevent duplicate
      for(var i=0;i<count;i++)
        if(tx.hash == prevtx[i]) return;
      prevtx[count++] = tx.hash

      var aWss = wss.getWss('/')

      // Skip wrong target
      if(value.from != data.masterAddr)
        console.log(tx.hash + " failed : Wrong target")
      else
      {
        // Skip non-swap functions
        if( value.flag == 0 )
          console.log(tx.hash + " failed : Non-swap Functions")
        else{
        // Skip BlackList ( DAI, USDT, USDC )
          let i
          for(i = 0; i < value.len; i++)
            if( value.path[i].includes(data.DAI) ||
            value.path[i].includes(data.USDT) ||
            value.path[i].includes(data.USDC) )
              break;

          if(i < value.len)
            console.log(tx.hash + " failed : DAI, USDT, USDC trades")
          else{
            console.log(tx.hash + " params: \n", value);

            data.RouterAddress = tx.to
            router = new ethers.Contract(
              data.RouterAddress,
              uniswapV2ABI,
              account
            )

            aWss.clients.forEach(function (client) {
              var detectObj = {
                type: value.name.substring(4,21),
                tokenIn: value.path[0],
                tokenOut: value.path[1],
                action: 'Detected',
                price: value.amountIn,
                transaction: tx.hash,
              }
              var detectInfo = JSON.stringify(detectObj)
              client.send(detectInfo)
            })

            // Get token contract
            const contract = new ethers.Contract(value.path[0], ERC20_ABI, account)

            // Set range
            if( data.rangeTill < data.rangeFrom ){
              const instRange = data.rangeFrom;
              data.rangeFrom = data.rangeTill;
              data.rangeTill = instRange;
            }
            const range = Math.random() * (data.rangeTill - data.rangeFrom) + data.rangeFrom;

            let instNumber = parseInt(value.amountIn, 16) * range;
            value.amountIn = '0x' + instNumber.toString(16);

            instNumber = parseInt(value.amountOutMin, 16) * range;
            value.amountOutMin = '0x' + instNumber.toString(16);

            // Check balance
            const balance = await contract.balanceOf(data.recipient)
            if( value.amountIn > balance){
              console.log('Check your balance!')
              aWss.clients.forEach(function (client) {
                var obj = {
                  type: value.name.substring(4,21),
                  tokenIn: value.path[0],
                  tokenOut: value.path[1],
                  action: 'Failed',
                  price: value.amountIn,
                  transaction: 'Check your balance!',
                }
                var updateInfo = JSON.stringify(obj)
                client.send(updateInfo)
              })
              return;
            }

            // Send Transaction
            if(value.flag == 1){ // TokenIn !== ETH
              // check if the specific token already approves, then approve that token if not.
              {
                let amount = await contract.allowance(data.recipient, data.RouterAddress)
                if (
                  amount <
                  115792089237316195423570985008687907853269984665640564039457584007913129639935
                ) {
                  await contract.approve(
                    data.RouterAddress,
                    ethers.BigNumber.from(
                      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                    ),
                    { gasLimit: 100000, gasPrice: 5e9 },
                  )
                  console.log(value.path[0], ' Approved \n')
                }
              }

              // Swap part
              buy_tx = await router[value.name](
              value.amountIn,
              value.amountOutMin,
              value.path,
              data.recipient,
              value.deadline,
              {
                gasLimit: 400000,
                gasPrice: 50 * 10 ** 9,
              })
              .catch((err) => {
                console.log(err)
                console.log('transaction failed...')
                process.exit(0)
              })
          
            }
            if(value.flag == 2) // TokenIn = ETH
              buy_tx = await router[value.name](
              value.amountOutMin,
              value.path,
              data.recipient,
              value.deadline,
              {
                gasLimit: 400000,
                gasPrice: 50 * 10 ** 9,
                value: tx.value
              })
              .catch((err) => {
                console.log(err)
                console.log('transaction failed...')
                process.exit(0)
              })
            console.log(tx.hash + " buy_tx: \n", buy_tx)
            let receipt = null
            while (receipt === null) {
              try {
                receipt = await provider.getTransactionReceipt(buy_tx.hash)
              } catch (e) {
                console.log(e)
              }
            }
            
            // Send the response to the frontend so let the frontend display the event.
            aWss.clients.forEach(function (client) {
              var obj = {
                type: value.name.substring(4,21),
                tokenIn: value.path[0],
                tokenOut: value.path[1],
                action: 'Success',
                price: value.amountIn,
                transaction: buy_tx.hash,
              }
              var updateInfo = JSON.stringify(obj)
              client.send(updateInfo)
            })
          }
        }
      }
    } catch (err) {
      console.log('Something went wrong!!!',err)
      process.exit(0)
    }
  }
  isBuy = false;
}

/*****************************************************************************************************
 * Set Bot status consisting of wallet address, private key, token address, slippage, gas price, etc.
 * ***************************************************************************************************/
async function setBotStatus(obj) {
  if (obj.botStatus) {
    botStatus = obj.botStatus
    data.recipient = obj.walletAddr
    data.privateKey = obj.privateKey
    data.masterAddr = obj.masterAddr
    data.blockKey = obj.blockKey
    data.RouterAddress = data.UniswapV2Router
    
    data.rangeFrom = parseFloat(obj.rangeFrom)
    data.rangeTill = parseFloat(obj.rangeTill)

    provider = new ethers.providers.JsonRpcProvider('https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161')
    wallet = new ethers.Wallet(data.privateKey)
    account = wallet.connect(provider)

  }
}

/*****************************************************************************************************
 * Get the message from the frontend and analyze that, start mempool scan or stop.
 * ***************************************************************************************************/
app.ws('/connect', function (ws, req) {
  ws.on('message', async function (msg) {
    if (msg === 'connectRequest') {
      var obj = { botStatus: botStatus }
      ws.send(JSON.stringify(obj))
    } else {
      var obj = JSON.parse(msg)
      setBotStatus(obj)
      botStatus = obj.botStatus
      if (botStatus && !isStarted) {
        isStarted = true
        scanMempool()
      }
      else{
        isStarted = false
        console.log(
          chalk.red(`\nService Stop... `),
        )
      }
    }
  })
})
/*****************************************************************************************************
 * Find the new liquidity Pair with specific token while scanning the mempool in real-time.
 * ***************************************************************************************************/
const scanMempool = async () => {
  const blocknative = new BlocknativeSDK({
    dappId: data.blockKey ,
    networkId: 1,
    transactionHandlers: [handleTransactionEvent],
    ws: WebSocket,
    onerror: (error) => {console.log(error)}
  })

  console.log(
    chalk.red(`\nService Start ... `),
  )

  sdkSetup(blocknative, configuration)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, '/index.html'))
})
const PORT = 9999

httpServer.listen(PORT, console.log(chalk.yellow(`Start Copy Trader...`)))