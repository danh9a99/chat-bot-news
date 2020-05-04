/*   
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

var customRules = {};
const 
  bodyParser = require('body-parser'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request');

var fs = require('fs');

const _ = require('lodash');
const   scriptRules = require('./script.json');
const   jokes = require('./script/JOKES.json');


var previousMessageHash = {};
var senderContext = {};
var isStopped = false;


var app = express();

app.set('port', process.env.PORT || 5000);
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables 
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = process.env.APP_SECRET ;

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = process.env.VALIDATION_TOKEN;

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {

  var data = req.body;
  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature with app secret:" + APP_SECRET);
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature: " + APP_SECRET);
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  if(isStopped == true)
  {
    return;
  }
  var data = req.body;
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

var firstName = "undefined";
var lastName = "undefined"; 

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
      callGetLocaleAPI(event, handleReceivedMessage);
}

function handleReceivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;


  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
//    console.log("Quick reply for message %s with payload %s",
 //     messageId, quickReplyPayload);

    messageText = quickReplyPayload;
    sendCustomMessage(senderID,messageText);
    return;
  }

  if (messageText) {
    if((isStopped == true) && (messageText !== "start")){
      return;
    }
  console.log("Received message for user %d and page %d at %d with message: %s", 
    senderID, recipientID, timeOfMessage,messageText);

    // If we receive a text message, check to see if it matches any special
    // keywords and send back the corresponding example. Otherwise, just echo
    // the text we received.
    switch (messageText.toLowerCase()) {
      case 'image':
        sendImageMessage(senderID, "http://messengerdemo.parseapp.com/img/rift.png");
        break;

      case 'gif':
        sendGifMessage(senderID);
        break;

      case 'audio':
        sendAudioMessage(senderID);
        break;

      case 'video':
        sendVideoMessage(senderID);
        break;

      case 'file':
        sendFileMessage(senderID);
        break;

      case 'button':
        sendButtonMessage(senderID);
        break;

      case 'generic':
        sendGenericMessage(senderID);
        break;


      case 'quick reply':
        sendQuickReply(senderID);
        break        

      case 'read receipt':
        sendReadReceipt(senderID);
        break        

      case 'typing on':
        sendTypingOn(senderID);
        break        

      case 'typing off':
        sendTypingOff(senderID);
        break        

      case 'user info':
        if(firstName)
            sendTextMessage(senderID,firstName);
        break        

      case 'add menu':
        addPersistentMenu();
        break        

      case 'remove menu':
        removePersistentMenu();
        break        

      case 'stop':  // Stop the Bot from responding if the admin sends this messages
         if(senderID ==  1073962542672604) {
            console.log("Stoppping bot");
            isStopped = true;
         }
         break

      case 'start': // start up again
         if(senderID ==  1073962542672604)  {
            console.log("Starting bot");
            isStopped = false;
         }
         break

      default:
         sendEnteredMessage(senderID, messageText);

    }
  } else if (messageAttachments) {
    if(messageAttachments[0].payload.url)
        sendJsonMessage(senderID, messageAttachments[0].payload.url);
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */

function receivedDeliveryConfirmation(event) {
  if(isStopped == true)
  {
    return;
  }
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */

function receivedPostback(event) {
  if(isStopped == true)
  {
    return;
  }
  callGetLocaleAPI(event, handleReceivedPostback);
}

function handleReceivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);

  // When a postback is called, we'll send a message back to the sender to 
  // let them know it was successful
  sendCustomMessage(senderID,payload);
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
  if(isStopped == true)
  {
    return;
  }
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId, path) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: path
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: "http://messengerdemo.parseapp.com/img/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: "http://messengerdemo.parseapp.com/audio/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: "http://messengerdemo.parseapp.com/video/allofus480.mov"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendFileMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: "http://messengerdemo.parseapp.com/files/test.txt"
        }
      }
    }
  };

  callSendAPI(messageData);
}


function getCovidNews(){
  var response = [];
  
  https.get(`https://code.junookyo.xyz/api/ncov-moh/data.json`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          
          console.log(profile.world.totalCases);
          console.log(profile.world.totalRecovered)
          console.log(profile.world.totalDeaths)
          console.log('done');
          // for(var i = 0; i<profile.VI.arrayArea.length; i++)
          // {
          //     response += profile.VI.arrayArea[i].Area + ": " + profile.VI.arrayArea[i].count + "\n";
          //     _tongCaNhiem += profile.VI.arrayArea[i].count;
          // }
          // console.log(response);
          // console.log(_tongCaNhiem);
      });
  });
}

function haddlePostback(sender_psid, received_postback){
  consosle.log("haddlePostback ok");

  let payload = received_postback.payload;
}

function sendSingleJsonMessage(recipientId,filename) {
  console.log("sendSingleJsonMessage " + filename); 
   try {
      filename = "./script/" + filename;
      var json  = require(filename);
      var fullMessage = { recipient: { id: recipientId  }};
      fullMessage.message = json;
      callSendAPI(fullMessage);
   }
   catch (e)
   {
      console.log("error in sendSingleJsonMessage " + e.message + " " + filename + " " + fullMessage);
   }
}

/* 
   Special handling for message that the sender typed in 
*/

function sendEnteredMessage(recipientId,messageText) {
var emojiString = ["😀","😁","😂","😃","😄","😅","😆","😇","😈","👿","😉","😊","☺️","😋","😌","😍","😎","😏","😐","😑","😒","😓","😔","😕","😖","😗","😘","😙","😚","😛","😜","😝","😞","😟","😠","😡","😢","😣","😤","😥","😦","😧","😨","😩","😪","😫","😬","😭","😮","😯","😰","😱","😲","😳","😴","😵","😶","😷","😸","😹","😺","😻","😼","😽","😾","😿","🙀","👣","👤","👥","👶","👶🏻","👶🏼","👶🏽","👶🏾","👶🏿","👦","👦🏻","👦🏼","👦🏽","👦🏾","👦🏿","👧","👧🏻","👧🏼","👧🏽","👧🏾","👧🏿","👨","👨🏻","👨🏼","👨🏽","👨🏾","👨🏿","👩","👩🏻","👩🏼","👩🏽","👩🏾","👩🏿","👪","👨‍👩‍👧","👨‍👩‍👧‍👦","👨‍👩‍👦‍👦","👨‍👩‍👧‍👧","👩‍👩‍👦","👩‍👩‍👧","👩‍👩‍👧‍👦","👩‍👩‍👦‍👦","👩‍👩‍👧‍👧","👨‍👨‍👦","👨‍👨‍👧","👨‍👨‍👧‍👦","👨‍👨‍👦‍👦","👨‍👨‍👧‍👧","👫","👬","👭","👯","👰","👰🏻","👰🏼","👰🏽","👰🏾","👰🏿","👱","👱🏻","👱🏼","👱🏽","👱🏾","👱🏿","👲","👲🏻","👲🏼","👲🏽","👲🏾","👲🏿","👳","👳🏻","👳🏼","👳🏽","👳🏾","👳🏿","👴","👴🏻","👴🏼","👴🏽","👴🏾","👴🏿","👵","👵🏻","👵🏼","👵🏽","👵🏾","👵🏿","👮","👮🏻","👮🏼","👮🏽","👮🏾","👮🏿","👷","👷🏻","👷🏼","👷🏽","👷🏾","👷🏿","👸","👸🏻","👸🏼","👸🏽","👸🏾","👸🏿","💂","💂🏻","💂🏼","💂🏽","💂🏾","💂🏿","👼","👼🏻","👼🏼","👼🏽","👼🏾","👼🏿","🎅","🎅🏻","🎅🏼","🎅🏽","🎅🏾","🎅🏿","👻","👹","👺","💩","💀","👽","👾","🙇","🙇🏻","🙇🏼","🙇🏽","🙇🏾","🙇🏿","💁","💁🏻","💁🏼","💁🏽","💁🏾","💁🏿","🙅","🙅🏻","🙅🏼","🙅🏽","🙅🏾","🙅🏿","🙆","🙆🏻","🙆🏼","🙆🏽","🙆🏾","🙆🏿","🙋","🙋🏻","🙋🏼","🙋🏽","🙋🏾","🙋🏿","🙎","🙎🏻","🙎🏼","🙎🏽","🙎🏾","🙎🏿","🙍","🙍🏻","🙍🏼","🙍🏽","🙍🏾","🙍🏿","💆","💆🏻","💆🏼","💆🏽","💆🏾","💆🏿","💇","💇🏻","💇🏼","💇🏽","💇🏾","💇🏿","💑","👩‍❤️‍👩","👨‍❤️‍👨","💏","👩‍❤️‍💋‍👩","👨‍❤️‍💋‍👨","🙌","🙌🏻","🙌🏼","🙌🏽","🙌🏾","🙌🏿","👏","👏🏻","👏🏼","👏🏽","👏🏾","👏🏿","👂","👂🏻","👂🏼","👂🏽","👂🏾","👂🏿","👀","👃","👃🏻","👃🏼","👃🏽","👃🏾","👃🏿","👄","💋","👅","💅","💅🏻","💅🏼","💅🏽","💅🏾","💅🏿","👋","👋🏻","👋🏼","👋🏽","👋🏾","👋🏿","👍","👍🏻","👍🏼","👍🏽","👍🏾","👍🏿","👎","👎🏻","👎🏼","👎🏽","👎🏾","👎🏿","☝","☝🏻","☝🏼","☝🏽","☝🏾","☝🏿","👆","👆🏻","👆🏼","👆🏽","👆🏾","👆🏿","👇","👇🏻","👇🏼","👇🏽","👇🏾","👇🏿","👈","👈🏻","👈🏼","👈🏽","👈🏾","👈🏿","👉","👉🏻","👉🏼","👉🏽","👉🏾","👉🏿","👌","👌🏻","👌🏼","👌🏽","👌🏾","👌🏿","✌","✌🏻","✌🏼","✌🏽","✌🏾","✌🏿","👊","👊🏻","👊🏼","👊🏽","👊🏾","👊🏿","✊","✊🏻","✊🏼","✊🏽","✊🏾","✊🏿","✋","✋🏻","✋🏼","✋🏽","✋🏾","✋🏿","💪","💪🏻","💪🏼","💪🏽","💪🏾","💪🏿","👐","👐🏻","👐🏼","👐🏽","👐🏾","👐🏿","🙏","🙏🏻","🙏🏼","🙏🏽","🙏🏾","🙏🏿","🌱","🌲","🌳","🌴","🌵","🌷","🌸","🌹","🌺","🌻","🌼","💐","🌾","🌿","🍀","🍁","🍂","🍃","🍄","🌰","🐀","🐁","🐭","🐹","🐂","🐃","🐄","🐮","🐅","🐆","🐯","🐇","🐰","🐈","🐱","🐎","🐴","🐏","🐑","🐐","🐓","🐔","🐤","🐣","🐥","🐦","🐧","🐘","🐪","🐫","🐗","🐖","🐷","🐽","🐕","🐩","🐶","🐺","🐻","🐨","🐼","🐵","🙈","🙉","🙊","🐒","🐉","🐲","🐊","🐍","🐢","🐸","🐋","🐳","🐬","🐙","🐟","🐠","🐡","🐚","🐌","🐛","🐜","🐝","🐞","🐾","⚡️","🔥","🌙","☀️","⛅️","☁️","💧","💦","☔️","💨","❄️","🌟","⭐️","🌠","🌄","🌅","🌈","🌊","🌋","🌌","🗻","🗾","🌐","🌍","🌎","🌏","🌑","🌒","🌓","🌔","🌕","🌖","🌗","🌘","🌚","🌝","🌛","🌜","🌞","🍅","🍆","🌽","🍠","🍇","🍈","🍉","🍊","🍋","🍌","🍍","🍎","🍏","🍐","🍑","🍒","🍓","🍔","🍕","🍖","🍗","🍘","🍙","🍚","🍛","🍜","🍝","🍞","🍟","🍡","🍢","🍣","🍤","🍥","🍦","🍧","🍨","🍩","🍪","🍫","🍬","🍭","🍮","🍯","🍰","🍱","🍲","🍳","🍴","🍵","☕️","🍶","🍷","🍸","🍹","🍺","🍻","🍼","🎀","🎁","🎂","🎃","🎄","🎋","🎍","🎑","🎆","🎇","🎉","🎊","🎈","💫","✨","💥","🎓","👑","🎎","🎏","🎐","🎌","🏮","💍","❤️","💔","💌","💕","💞","💓","💗","💖","💘","💝","💟","💜","💛","💚","💙","🏃","🏃🏻","🏃🏼","🏃🏽","🏃🏾","🏃🏿","🚶","🚶🏻","🚶🏼","🚶🏽","🚶🏾","🚶🏿","💃","💃🏻","💃🏼","💃🏽","💃🏾","💃🏿","🚣","🚣🏻","🚣🏼","🚣🏽","🚣🏾","🚣🏿","🏊","🏊🏻","🏊🏼","🏊🏽","🏊🏾","🏊🏿","🏄","🏄🏻","🏄🏼","🏄🏽","🏄🏾","🏄🏿","🛀","🛀🏻","🛀🏼","🛀🏽","🛀🏾","🛀🏿","🏂","🎿","⛄️","🚴","🚴🏻","🚴🏼","🚴🏽","🚴🏾","🚴🏿","🚵","🚵🏻","🚵🏼","🚵🏽","🚵🏾","🚵🏿","🏇","🏇🏻","🏇🏼","🏇🏽","🏇🏾","🏇🏿","⛺️","🎣","⚽️","🏀","🏈","⚾️","🎾","🏉","⛳️","🏆","🎽","🏁","🎹","🎸","🎻","🎷","🎺","🎵","🎶","🎼","🎧","🎤","🎭","🎫","🎩","🎪","🎬","🎨","🎯","🎱","🎳","🎰","🎲","🎮","🎴","🃏","🀄️","🎠","🎡","🎢","🚃","🚞","🚂","🚋","🚝","🚄","🚅","🚆","🚇","🚈","🚉","🚊","🚌","🚍","🚎","🚐","🚑","🚒","🚓","🚔","🚨","🚕","🚖","🚗","🚘","🚙","🚚","🚛","🚜","🚲","🚏","⛽️","🚧","🚦","🚥","🚀","🚁","✈️","💺","⚓️","🚢","🚤","⛵️","🚡","🚠","🚟","🛂","🛃","🛄","🛅","💴","💶","💷","💵","🗽","🗿","🌁","🗼","⛲️","🏰","🏯","🌇","🌆","🌃","🌉","🏠","🏡","🏢","🏬","🏭","🏣","🏤","🏥","🏦","🏨","🏩","💒","⛪️","🏪","🏫","🇦🇺","🇦🇹","🇧🇪","🇧🇷","🇨🇦","🇨🇱","🇨🇳","🇨🇴","🇩🇰","🇫🇮","🇫🇷","🇩🇪","🇭🇰","🇮🇳","🇮🇩","🇮🇪","🇮🇱","🇮🇹","🇯🇵","🇰🇷","🇲🇴","🇲🇾","🇲🇽","🇳🇱","🇳🇿","🇳🇴","🇵🇭","🇵🇱","🇵🇹","🇵🇷","🇷🇺","🇸🇦","🇸🇬","🇿🇦","🇪🇸","🇸🇪","🇨🇭","🇹🇷","🇬🇧","🇺🇸","🇦🇪","🇻🇳","⌚️","📱","📲","💻","⏰","⏳","⌛️","📷","📹","🎥","📺","📻","📟","📞","☎️","📠","💽","💾","💿","📀","📼","🔋","🔌","💡","🔦","📡","💳","💸","💰","💎","🌂","👝","👛","👜","💼","🎒","💄","👓","👒","👡","👠","👢","👞","👟","👙","👗","👘","👚","👕","👔","👖","🚪","🚿","🛁","🚽","💈","💉","💊","🔬","🔭","🔮","🔧","🔪","🔩","🔨","💣","🚬","🔫","🔖","📰","🔑","✉️","📩","📨","📧","📥","📤","📦","📯","📮","📪","📫","📬","📭","📄","📃","📑","📈","📉","📊","📅","📆","🔅","🔆","📜","📋","📖","📓","📔","📒","📕","📗","📘","📙","📚","📇","🔗","📎","📌","✂️","📐","📍","📏","🚩","📁","📂","✒️","✏️","📝","🔏","🔐","🔒","🔓","📣","📢","🔈","🔉","🔊","🔇","💤","🔔","🔕","💭","💬","🚸","🔍","🔎","🚫","⛔️","📛","🚷","🚯","🚳","🚱","📵","🔞","🉑","🉐","💮","㊙️","㊗️","🈴","🈵","🈲","🈶","🈚️","🈸","🈺","🈷","🈹","🈳","🈂","🈁","🈯️","💹","❇️","✳️","❎","✅","✴️","📳","📴","🆚","🅰","🅱","🆎","🆑","🅾","🆘","🆔","🅿️","🚾","🆒","🆓","🆕","🆖","🆗","🆙","🏧","♈️","♉️","♊️","♋️","♌️","♍️","♎️","♏️","♐️","♑️","♒️","♓️","🚻","🚹","🚺","🚼","♿️","🚰","🚭","🚮","▶️","◀️","🔼","🔽","⏩","⏪","⏫","⏬","➡️","⬅️","⬆️","⬇️","↗️","↘️","↙️","↖️","↕️","↔️","🔄","↪️","↩️","⤴️","⤵️","🔀","🔁","🔂","#⃣","0⃣","1⃣","2⃣","3⃣","4⃣","5⃣","6⃣","7⃣","8⃣","9⃣","🔟","🔢","🔤","🔡","🔠","ℹ️","📶","🎦","🔣","➕","➖","〰","➗","✖️","✔️","🔃","™","©","®","💱","💲","➰","➿","〽️","❗️","❓","❕","❔","‼️","⁉️","❌","⭕️","💯","🔚","🔙","🔛","🔝","🔜","🌀","Ⓜ️","⛎","🔯","🔰","🔱","⚠️","♨️","♻️","💢","💠","♠️","♣️","♥️","♦️","☑️","⚪️","⚫️","🔘","🔴","🔵","🔺","🔻","🔸","🔹","🔶","🔷","▪️","▫️","⬛️","⬜️","◼️","◻️","◾️","◽️","🔲","🔳","🕐","🕑","🕒","🕓","🕔","🕕","🕖","🕗","🕘","🕙","🕚","🕛","🕜","🕝","🕞","🕟","🕠","🕡","🕢","🕣","🕤","🕥","🕦","🕧"]

console.log("sendEnteredMessage "+ messageText);

    if( previousMessageHash[recipientId] === 'send a message') {
         sendTextMessage(1073962542672604, messageText); // send a message to Matthew directly
    }
    else if( senderContext[recipientId].state === 'addKeywordStep1') {
         addKeywordStep2(recipientId,messageText);
    }
    else if( senderContext[recipientId].state === 'addKeywordText') {
         addKeywordTextStep2(recipientId,messageText);
    }
    else if( senderContext[recipientId].state === 'addKeywordButton') {
         addKeywordButtonStep2(recipientId,messageText);
    }
    else if (emojiString.indexOf(messageText.substring(0,2)) > -1) {
         var maxLength = emojiString.length;
         var random = Math.floor(Math.random() * maxLength);
         messageText = emojiString[random];
         sendTextMessage(recipientId,messageText);
    }
    else { 
         sendCustomMessage(recipientId,messageText);
   }
}

function sendCustomMessage(recipientId,messageText) {

console.log("sendCustoMessage "+ messageText);

    switch (messageText.toLowerCase()) {
         
      
      case 'add keyword':
        addKeywordStep1(recipientId);
        break        

      case 'list keywords':
        sendKeywordList(recipientId);
        break        

      case 'addkeyword_text':
        addKeywordText(recipientId);
        break

      case 'addkeyword_button':
        addKeywordButton(recipientId);
        break

      case 'addkeyword_button1':
        addKeywordButtonStep3(recipientId,1);
        break

      case 'addkeyword_button2':
        addKeywordButtonStep3(recipientId,2);
        break

      case 'addkeyword_button3':
        addKeywordButtonStep3(recipientId,3);
        break


      default:
         sendJsonMessage(recipientId,messageText);

    }
    previousMessageHash[recipientId] = messageText.toLowerCase();
}

function sendJsonMessage(recipientId,keyword) {
console.log("sendJsonMessage " + keyword);


  if (_.has(scriptRules, keyword.toUpperCase())) {
      sendSingleJsonMessage(recipientId,scriptRules[keyword.toUpperCase()]);
  }
  else if (_.has(customRules, keyword.toUpperCase())) {
      sendSingleJsonMessage(recipientId,customRules[keyword.toUpperCase()]);
  }
  else  if (keyword == "VN"){
    let stringText = "";
    https.get(`https://code.junookyo.xyz/api/ncov-moh/data.json`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          stringText = "Việt Nam\nSố người nhiễm: " + 
          profile.data.vietnam.cases +
          "\nBình phục: " + profile.data.vietnam.recovered +
          "\nTử vong: " + profile.data.vietnam.deaths;
          // callSendAPICovid(recipientId,"Việt Nam\nSố người nhiễm: " + 
          //                   profile.data.vietnam.cases +
          //                   "\nBình phục: " + profile.data.vietnam.recovered +
          //                   "\nTử vong: " + profile.data.vietnam.deaths);
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: {
              text: stringText,
              quick_replies: [
                {
                  "content_type":"text",
                  "title":"Thế giới",
                  "payload":"GB"
                },
                {
                  "content_type":"text",
                  "title":"Top",
                  "payload":"contact"
                },
                {
                  "content_type":"text",
                  "title":"Home",
                  "payload":"home"
                }
              ]
            }
          };
        
          callSendAPI(messageData);
      });
  });
  }
  else if (keyword == "GB"){
    https.get(`https://code.junookyo.xyz/api/ncov-moh/data.json`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          
          callSendAPICovid(recipientId,"Thế giới\nSố người nhiễm: " + 
                            profile.data.global.cases +
                            "\nBình phục: " + profile.data.global.recovered +
                            "\nTử vong: " + profile.data.global.deaths);
      
      });
  });
  }
  else if (keyword == "top10_cases"){
    var most_cases = 0
    let top_cases ="TOP CA NHIỄM\n\n";
    var top_countries = []
    https.get(`https://api.covid19api.com/summary`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          for(var i = 0; i <profile.Countries.length-1; i++){
              for(var j = i+1; j < profile.Countries.length; j++){
                if (profile.Countries[i].TotalConfirmed < profile.Countries[j].TotalConfirmed){
                    most_cases = profile.Countries[i];
                    profile.Countries[i] = profile.Countries[j];
                    profile.Countries[j] = most_cases;
                }
              }      
                     
          }
         for ( var index = 0; index < 10; index++){ 
          var temp = index + 1;
          if(profile.Countries[index].Country == "United States of America"){
            profile.Countries[index].Country = "United States"
           }
           if(profile.Countries[index].CountryCode == "IR"){
            profile.Countries[index].Country = "Iran"
          }
           top_cases = top_cases + temp + ". " + profile.Countries[index].Country + ": " + profile.Countries[index].TotalConfirmed + "\n";
         }
         callSendAPICovid(recipientId,top_cases);
      });
  });
  
  }
  else if (keyword == "top10_recovered"){
    var most_cases = 0
    let top_recovered ="TOP HỒI PHỤC\n\n";
    var top_countries = []
    https.get(`https://api.covid19api.com/summary`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          for(var i = 0; i <profile.Countries.length-1; i++){
              for(var j = i+1; j < profile.Countries.length; j++){
                if (profile.Countries[i].TotalRecovered < profile.Countries[j].TotalRecovered){
                    most_cases = profile.Countries[i];
                    profile.Countries[i] = profile.Countries[j];
                    profile.Countries[j] = most_cases;
                }
              }      
                     
          }
         for ( var index = 0; index < 10; index++){ 
           var temp = index + 1
           if(profile.Countries[index].Country == "United States of America"){
            profile.Countries[index].Country = "United States"
           }
           if(profile.Countries[index].CountryCode == "IR"){
            profile.Countries[index].Country = "Iran"
          }
           top_recovered = top_recovered + temp + ". " + profile.Countries[index].Country + ": " + profile.Countries[index].TotalRecovered + "\n";
         }
         callSendAPICovid(recipientId,top_recovered);
      });
  });
  }

  else if (keyword == "top10_deaths"){
    var most_cases = 0
    let top_deaths ="TOP TỬ VONG\n\n";
    var top_countries = []
    https.get(`https://api.covid19api.com/summary`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          for(var i = 0; i <profile.Countries.length-1; i++){
              for(var j = i+1; j < profile.Countries.length; j++){
                if (profile.Countries[i].TotalDeaths < profile.Countries[j].TotalDeaths){
                    most_cases = profile.Countries[i];
                    profile.Countries[i] = profile.Countries[j];
                    profile.Countries[j] = most_cases;
                }
              }      
                     
          }
         for ( var index = 0; index < 10; index++){ 
          var temp = index + 1;
          if(profile.Countries[index].Country == "United States of America"){
            profile.Countries[index].Country = "United States"
           }
           if(profile.Countries[index].CountryCode == "IR"){
            profile.Countries[index].Country = "Iran"
          }
           top_deaths = top_deaths + temp + ". " + profile.Countries[index].Country + ": " + profile.Countries[index].TotalDeaths + "\n";
         }
         
         //callSendAPICovid(recipientId,top_deaths);
         var messageData = {
          recipient: {
            id: recipientId
          },
          message: {      
            text: top_deaths,   
            quick_replies: [
              {
                "content_type":"text",
                "title":"Tỷ lệ tử vong 😔",
                "payload":"ty_le_tu_vong_cao_nhat"
              },   
              {
                "content_type":"text",
                "title":"Home",
                "payload":"home"
              }
            ]
          }
        };
        callSendAPI(messageData);
      });
  });
  }
  else if (keyword == "ty_le_tu_vong_cao_nhat"){
    var most_cases = 0
    let string_tyle = "Tỷ lệ tử vong cao nhất ở ";
    var tyLe = 0;
    let country_string = "";
    let info_country = "";
    https.get(`https://api.covid19api.com/summary`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);         
          for(var i = 1 ; i < profile.Countries.length; i ++){
            if(tyLe < profile.Countries[i].TotalDeaths / profile.Countries[i].TotalConfirmed * 100){
              tyLe = profile.Countries[i].TotalDeaths / profile.Countries[i].TotalConfirmed * 100
              country_string = profile.Countries[i].Country;
              info_country = profile.Countries[i].Country + "\nSố ca nhiễm: " + profile.Countries[i].TotalConfirmed + "\nHồi phục: " + profile.Countries[i].TotalRecovered + "\nTử vong: " + profile.Countries[i].TotalDeaths;
            }
          }
          string_tyle = string_tyle + country_string + " với: " + tyLe + "%" + "\n\n" + info_country;
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: {      
              text: string_tyle,   
              quick_replies: [
                {
                  "content_type":"text",
                  "title":"Xem thêm",
                  "payload":"thong_tin_them"
                },   
                {
                  "content_type":"text",
                  "title":"Home",
                  "payload":"home"
                }
              ]
            }
          };
          callSendAPI(messageData);
        });
  
  });
  }
  else if(keyword == "thong_tin_them"){
    var messageData = {
      recipient: {
        id: recipientId
      },
      message: {      
        text: "Đang tìm ánh sáng của Đảng, chờ tôi nhé!",   
        quick_replies: [
          {
            "content_type":"text",
            "title":"Home",
            "payload":"home"
          }
        ]
      }
    };
    callSendAPI(messageData);
  }
  else if(keyword == "about_me"){
    var messageData = {
      recipient: {
        id: recipientId
      },
      message: {      
        text: "Tôi được tạo bởi Bapp, người muốn tôi sẽ giúp các bạn nắm được thông tin về tình hình dịch bệnh Covid-19",   
        quick_replies: [
          {
            "content_type":"text",
            "title":"Home",
            "payload":"home"
          }
        ]
      }
    };
    callSendAPI(messageData);
  }

  else  if (keyword == "tin-nhanh1"){
    let stringTitle = "";
    let stringDescription = "";
    let stringImage = "";
    let stringLink = "";
    https.get(`https://wrapapi.com/use/bapp-it17/vnexpress/suckhoe/0.0.1?wrapAPIKey=j751CwjyTl5L6re4c1SiUWiKaGtWJlb7`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          stringTitle = profile.data.output.titles[0];
          stringDescription = profile.data.output.descriptions[0];
          stringImage = profile.data.output.images[0];
          stringLink == profile.data.output.links[0];

          
          console.log(stringImage);
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: 
            {
              "attachment": {
                "type": "template",
                "payload": {
                  "template_type": "generic",
                  "elements": [
                    {
                      "title": stringTitle,
                      "subtitle": "",
                      "item_url": stringLink,
                      "image_url": stringImage,                    
                      "buttons": [    
                        {
                          "type": "postback",
                          "title": "Đọc nhanh",
                          "payload": "doc-nhanh-1"
                        },
                        {
                          "type": "web_url",
                          "url": profile.data.output.links[0],
                          "title": "Truy cập"
                        }
                       
                        ]
                    },
                    {
                      "title": profile.data.output.titles[1],
                      "subtitle": "",
                      "item_url": stringLink,
                      "image_url":"https://raw.githubusercontent.com/danh9a99/chat-bot-news/master/img/express_logo.png",                    
                      "buttons": [    
                        {
                          "type": "postback",
                          "title": "Đọc nhanh",
                          "payload": "doc-nhanh-2"
                        },
                        {
                          "type": "web_url",
                          "url": profile.data.output.links[1],
                          "title": "Truy cập"
                        }
                       
                        ]
                    },
                    {
                      "title": profile.data.output.titles[2],
                      "subtitle": "",
                      "item_url": stringLink,
                      "image_url": "https://raw.githubusercontent.com/danh9a99/chat-bot-news/master/img/express_logo.png",                    
                      "buttons": [    
                        {
                          "type": "postback",
                          "title": "Đọc nhanh",
                          "payload": "doc-nhanh-3"
                        },
                        {
                          "type": "web_url",
                          "url": profile.data.output.links[2],
                          "title": "Truy cập"
                        }
                       
                        ]
                    }
                  
                    
                    // {
                    //   "title": "Classic White T-Shirt",
                    //   "image_url": stringImage,
                    //   "subtitle": "See all our colors",
                    //   "default_action": {
                    //     "type": "web_url",
                    //     "url": "https://peterssendreceiveapp.ngrok.io/view?item=100",
                    //     "messenger_extensions": false,
                    //     "webview_height_ratio": "tall"
                    //   }
                    // }
                    
                  ]                  
                }
              }
            }
          };  
        
          callSendAPI(messageData);
      });
  });
  }
  else if(keyword = "tin-nhanh"){
    let stringTitle = "";
    let stringDescription = "";
    let stringImage = "";
    let stringLink = "";
    https.get(`https://wrapapi.com/use/bapp-it17/vnexpress/suckhoe/0.0.1?wrapAPIKey=j751CwjyTl5L6re4c1SiUWiKaGtWJlb7`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);
          stringTitle = profile.data.output.titles[0];
          stringDescription = profile.data.output.descriptions[0];
          stringImage = profile.data.output.images[0];
          stringLink == profile.data.output.links[0];

          
          console.log(stringImage);
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: 
            {
              "type": "vertical",
              "tag": "generic",
              "elements": [
                {
                  "type": "vertical",
                  "elements": [
                    {
                      "type": "image",
                      "url": "https://i.pinimg.com/736x/a0/67/5e/a0675e5161d7ae5be2550987f397a641--flower-shops-paper-flowers.jpg",
                      "tooltip": "Flowers"
                    },
                    {
                      "type": "text",
                      "tag": "title",
                      "text": "Birthday Bouquet",
                      "tooltip": "Title"
                    },
                    {
                      "type": "text",
                      "tag": "subtitle",
                      "text": "Wild flowers",
                      "tooltip": "subtitle"
                    },
                    {
                      "type": "button",
                      "tooltip": "publish text example",
                      "title": "publish text example",
                      "click": {
                        "actions": [
                          {
                            "type": "publishText",
                            "text": "published text button tap"
                          }
                        ]
                      }
                    },
                    {
                      "type": "button",
                      "tooltip": "URL button example",
                      "title": "URL button example",
                      "click": {
                        "actions": [
                          {
                            "type": "link",
                            "name": "URL button tap",
                            "uri": "https://www.pinterest.com/lyndawhite/beautiful-flowers/"
                          }
                        ]
                      }
                    },
                    {
                      "type": "button",
                      "title": "Navigate",
                      "click": {
                           "actions": [
                          {
                            "type": "navigate",
                            "lo": 40.7562,
                            "la": -73.99861
                          }
                        ]
                      }
                    }
                  ]
                }]}
          };  
        
          callSendAPI(messageData);
      });
  });
  }
  else if(keyword == "doc-nhanh-1"){
    let stringDescription = "";
    https.get(`https://wrapapi.com/use/bapp-it17/vnexpress/suckhoe/0.0.1?wrapAPIKey=j751CwjyTl5L6re4c1SiUWiKaGtWJlb7`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);         
          stringDescription == "<test>" + profile.data.output.descriptions[0];
          console.log(stringDescription);
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: {      
              text:  profile.data.output.descriptions[0],   
              quick_replies: [
                {
                  "content_type":"text",
                  "title":"Tin khác",
                  "payload":"tin-khac"
                },   
                {
                  "content_type":"text",
                  "title":"Home",
                  "payload":"home"
                }
              ]
            }
          };
        
          callSendAPI(messageData);
      });
  });
  }
  else if(keyword == "doc-nhanh-2"){
    let stringDescription = "";
    https.get(`https://wrapapi.com/use/bapp-it17/vnexpress/suckhoe/0.0.1?wrapAPIKey=j751CwjyTl5L6re4c1SiUWiKaGtWJlb7`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);         
          stringDescription == "<test>" + profile.data.output.descriptions[0];
          console.log(stringDescription);
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: {      
              text:  profile.data.output.descriptions[1],   
              quick_replies: [
                {
                  "content_type":"text",
                  "title":"Tin khác",
                  "payload":"tin-khac"
                },   
                {
                  "content_type":"text",
                  "title":"Home",
                  "payload":"home"
                }
              ]
            }
          };
        
          callSendAPI(messageData);
      });
  });
  }

  else if(keyword == "doc-nhanh-3"){
    let stringDescription = "";
    https.get(`https://wrapapi.com/use/bapp-it17/vnexpress/suckhoe/0.0.1?wrapAPIKey=j751CwjyTl5L6re4c1SiUWiKaGtWJlb7`, res => {
      let body = "";
      // read data
      res.on("data" ,data => {
          body += data.toString();
      });
      // print data
      res.on("end", () => {
          var profile = JSON.parse(body);         
          stringDescription == "<test>" + profile.data.output.descriptions[0];
          console.log(stringDescription);
          var messageData = {
            recipient: {
              id: recipientId
            },
            message: {      
              text:  profile.data.output.descriptions[2],   
              quick_replies: [
                {
                  "content_type":"text",
                  "title":"Tin khác",
                  "payload":"tin-khac"
                },   
                {
                  "content_type":"text",
                  "title":"Home",
                  "payload":"home"
                }
              ]
            }
          };
        
          callSendAPI(messageData);
      });
  });
  }  
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    "recipient": {
      "id": recipientId
    },
    "message": {
      "text": messageText,
      "metadata": "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Joke with Quick Reply buttons.
 *
 */
function sendJoke(recipientId) {

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: 
    {
      "attachment": {
        "type": "template",
        "payload": {
         "template_type": "generic",
          "elements": [
        
          {
            "title": "TIN TỨC", 
            "subtitle": "Dữ liệu lấy từ #vnexpress",           
            "image_url": "https://raw.githubusercontent.com/danh9a99/chat-bot-news/master/img/express_logo.png",
            "buttons": [
            {
              "type": "postback",
              "title": "Tin nhanh",
              "payload": "tin-nhanh"
            }
            ]
          }
          
          ]
        }
      }
    }



  };  

  callSendAPI(messageData);
}

/*
 * Send the user information back, the bot grabs this for every message
 *
 */

/*
 * Simple example of an external http call with parsing.
 *
 */



function getCovidNews(){
  https.get(`https://code.junookyo.xyz/api/ncov-moh/data.json`, res => {
    let body = "";
    // read data
    res.on("data" ,data => {
        body += data.toString();
    });
    // print data
    res.on("end", () => {
        var profile = JSON.parse(body);
        
        console.log(profile.data.global.cases);
        console.log(profile.data.global.recovered)
        console.log(profile.data.global.deaths)
        console.log('done');
        // for(var i = 0; i<profile.VI.arrayArea.length; i++)
        // {
        //     response += profile.VI.arrayArea[i].Area + ": " + profile.VI.arrayArea[i].count + "\n";
        //     _tongCaNhiem += profile.VI.arrayArea[i].count;
        // }
        // console.log(response);
        // console.log(_tongCaNhiem);
    });
});
}


/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons:[{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPED_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: 
    {
      "attachment": {
        "type": "template",
        "payload": {
         "template_type": "generic",
          "elements": [
          {
            "title": "COVID-19",
            "subtitle": "Thống kê tình hình dịch",
            "item_url": "https://moh.gov.vn/",               
            "image_url": "https://raw.githubusercontent.com/danh9a99/chat-bot-news/master/img/corona_1.jpg",
            "buttons": [
            {
              "type": "postback",
              "title": "Việt Nam",
              "payload": "VN"
            },
            {
              "type": "postback",
              "title": "Thế giới",
              "payload": "GB"
            },
            {
              "type": "postback",
              "title": "Top 10",
              "payload": "contact"
            }
            ]
          }
         
          // {
          //   "title": "Cá nhân hóa",              
          //   "image_url": "https://raw.githubusercontent.com/danh9a99/fb-robot/master/img/robot.png",
          //   "buttons": [
          //   {
          //     "type": "postback",
          //     "title": "Tùy chỉnh bot",
          //     "payload": "custom"
          //   }
          //   ]
          // }
        
          ]
        }
      }
    }



  };  

  callSendAPI(messageData);
}




/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "Some regular buttons and a location test",
      metadata: "DEVELOPER_DEFINED_METADATA",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Action",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
        },
        {
          "content_type":"text",
          "title":"Something else",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_SOMETHING"
        },
        {
          "content_type":"location",
          "title":"Send Location",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_LOCATION"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}


/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPICovid(sender_psid, response) {
  // Construct the message body
  let request_body = {
    recipient: {
      id: sender_psid
    },
    message: {
      text: response
    }
  };
  // Send the HTTP request to the Messenger Platform
  request(
    {
      uri: "https://graph.facebook.com/v2.6/me/messages",
      qs: {
        access_token: PAGE_ACCESS_TOKEN
  
      },
      method: "POST",
      json: request_body
    },
    (err, res, body) => {
      if (!err) {
        console.log("message sent!");
      } else {
        console.error("Unable to send message:" + err);
      }
    }
  );
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Unable to send message. :" + response.error);
    }
  });  
}

/*
 * Call the Get Locale API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callGetLocaleAPI(event, handleReceived) {
    var userID = event.sender.id;
    var http = require('https');
    var path = '/v2.6/' + userID +'?fields=first_name,last_name,profile_pic,locale,timezone,gender&access_token=' + PAGE_ACCESS_TOKEN;
    var options = {
      host: 'graph.facebook.com',
      path: path
    };
    
    if(senderContext[userID])
    {
       firstName = senderContext[userID].firstName; 
       lastName = senderContext[userID].lastName; 
       console.log("found " + JSON.stringify(senderContext[userID]));
       if(!firstName) 
          firstName = "undefined";
       if(!lastName) 
          lastName = "undefined";
       handleReceived(event);
       return;
    }

    var req = http.get(options, function(res) {
      //console.log('STATUS: ' + res.statusCode);
      //console.log('HEADERS: ' + JSON.stringify(res.headers));

      // Buffer the body entirely for processing as a whole.
      var bodyChunks = [];
      res.on('data', function(chunk) {
        // You can process streamed parts here...
        bodyChunks.push(chunk);
      }).on('end', function() {
        var body = Buffer.concat(bodyChunks);
        var bodyObject = JSON.parse(body);
        firstName = bodyObject.first_name;
        lastName = bodyObject.last_name;
        if(!firstName) 
          firstName = "undefined";
        if(!lastName) 
          lastName = "undefined";
        senderContext[userID] = {};
        senderContext[userID].firstName = firstName;
        senderContext[userID].lastName = lastName;
        console.log("defined " + JSON.stringify(senderContext));
        handleReceived(event);
      })
    });
    req.on('error', function(e) {
      console.log('ERROR: ' + e.message);
    });
}


function addPersistentMenu(){
 request({
    url: 'https://graph.facebook.com/v2.6/me/messenger_profile',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json:{
  "get_started":{
    "payload":"GET_STARTED_PAYLOAD"
   }
 }
}, function(error, response, body) {
    console.log("Add persistent menu " + response)
    if (error) {
        console.log('Error sending messages: ', error)
    } else if (response.body.error) {
        console.log('Error: ', response.body.error)
    }
})
 request({
    url: 'https://graph.facebook.com/v2.6/me/messenger_profile',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json:{
"persistent_menu":[
    {
      "locale":"default",
      "composer_input_disabled":true,
      "call_to_actions":[
        {
          "title":"COVID-19",
          "type":"postback",
          "payload":"HOME"
        },
        {
          "title":"Tin Tức",
          "type":"postback",
          "payload":"tin-nhanh"
        },
        // {
        //   "title":"Nested Menu Example",
        //   "type":"nested",
        //   "call_to_actions":[
        //     {
        //       "title":"Who am I",
        //       "type":"postback",
        //       "payload":"WHO"
        //     },
        //     {
        //       "title":"Joke",
        //       "type":"postback",
        //       "payload":"joke"
        //     },
        //     {
        //       "title":"Contact Info",
        //       "type":"postback",
        //       "payload":"CONTACT"
        //     }
        //   ]
        // },
        {
          "type": "postback",
          "title":"About me",
          "payload": "about_me"
        }
      ]
    },
    {
      "locale":"zh_CN",
      "composer_input_disabled":false
    }
    ]
    }

}, function(error, response, body) {
    console.log(response)
    if (error) {
        console.log('Error sending messages: ', error)
    } else if (response.body.error) {
        console.log('Error: ', response.body.error)
    }
})

}

function removePersistentMenu(){
 request({
    url: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json:{
        setting_type : "call_to_actions",
        thread_state : "existing_thread",
        call_to_actions:[ ]
    }

}, function(error, response, body) {
    console.log(response)
    if (error) {
        console.log('Error sending messages: ', error)
    } else if (response.body.error) {
        console.log('Error: ', response.body.error)
    }
})
}

function addKeywordStep1(recipientId)
{
   sendTextMessage(recipientId,"Keyword để kích hoạt các hành động của Bot. Bạn có thể nhập keyword hoặc nó có thể được kích hoạt bởi một liên kết. Keyword có thể chứa chữ cái, số và dấu cách. Vui lòng nhập keyword:");
   senderContext[recipientId].state = "addKeywordStep1";
}

function addKeywordStep2(recipientId, messageText)
{
   senderContext[recipientId].keyword = messageText;
   senderContext[recipientId].state = "addKeywordStep2";
   sendJsonMessage(recipientId,"addKeywordStep2");
}

function stateMachineError(recipientId)
{
   sendTextMessage(recipientId,"Sorry the Bot is confused.  We will have to start again.");
   senderContext[recipientId].state = "";
   senderContext[recipientId].keyword = "";
}

function addKeywordText(recipientId)
{
   console.log("addKeywordText " + JSON.stringify(senderContext));

   if( senderContext[recipientId].state === "addKeywordStep2")
   {
       sendTextMessage(recipientId,"Vui lòng nhập văn bản sẽ được gửi cho bạn khi từ khóa này được sử dụng.");
       senderContext[recipientId].state = "addKeywordText";
   }
   else
   {
       stateMachineError(recipientId);
   }
}

function addKeywordTextStep2(recipientId,messageText)
{
   if( senderContext[recipientId].state === "addKeywordText")
   {
      var filename = senderContext[recipientId].keyword.toUpperCase()+ ".json";
      var contents = '{"text": "' + messageText + '" }';
      console.log("contents: "+contents);
      fs.writeFile("script/"+filename, contents, function(err) {
           if(err) {
               return console.log(err);
           }
           console.log("The file was saved!");
           senderContext[recipientId].state = "";
           customRules[senderContext[recipientId].keyword.toUpperCase()] = senderContext[recipientId].keyword.toUpperCase();
           sendTextMessage(recipientId,"Đã thêm Keyword. Thử xem nào!!");

/*
fs.readFile(filename, function read(err, data) {
    if (err) {
        throw err;
    }

    // Invoke the next step here however you like
    console.log("file contains: " + data);  
});
*/
        }
     ); 
   }
   else
   {
       stateMachineError(recipientId);
   }
}

function addKeywordButton(recipientId)
{
   console.log("addKeywordButton " + JSON.stringify(senderContext));

   if( senderContext[recipientId].state === "addKeywordStep2")
   {
       sendTextMessage(recipientId,"Please type in the title for the button.");
       senderContext[recipientId].state = "addKeywordButton";
   }
   else
   {
       stateMachineError(recipientId);
   }
}

function addKeywordButtonStep2(recipientId, messageText)
{
   if( senderContext[recipientId].state === "addKeywordButton")
   {
       senderContext[recipientId].state = "addKeywordButtonStep2";
       sendSingleJsonMessage(recipientId,"ADDKEYWORD_BUTTONSTEP2.json");
   }
   else
   {
       stateMachineError(recipientId);
   }
}

function addKeywordButtonStep3(recipientId, buttonCount)
{
   if( senderContext[recipientId].state === "addKeywordButtonStep2")
   {
       senderContext[recipientId].state = "addKeywordButtonStep3";
       senderContext[recipientId].buttonCount = buttonCount;
       sendSingleJsonMessage(recipientId,"ADDKEYWORD_BUTTONSTEP3.json");
   }
   else
   {
       stateMachineError(recipientId);
   }
}

function sendKeywordList(recipientId)
{
//  if (customRules.length > 0) 
  if (1)
  {
      var keys = Object.keys(customRules);

      for (var p in keys) 
      {
         if (keys.hasOwnProperty(p))
         {
            sendTextMessage(recipientId,keys[p]);
         }
      }
  } 
  else
  {
    sendTextMessage(recipientId,"No custom keywords defined yet");
  }
  return;
}


// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;

