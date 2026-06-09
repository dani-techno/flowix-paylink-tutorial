Flowix Paylink Tutorial

Build a modern payment link system using Node.js, Express, and the Flowix API.

This repository is the source code used in the Flowix Paylink Tutorial series, where we create a complete payment link application from scratch, including invoice generation, payment status tracking, webhook handling, and automatic payment verification.

Features

- Admin Login System
- Payment Link Generator
- Dynamic Invoice Pages
- Flowix Deposit Integration
- Automatic Payment Status Updates
- Webhook Verification
- Expired Invoice Handling
- Responsive Modern UI
- QR Payment Support
- Virtual Account Support
- Payment Link Support
- Auto Polling & Real-Time Updates

Technology Stack

- Node.js
- Express.js
- Vanilla JavaScript
- HTML5
- CSS3
- Flowix API

Project Structure

.
├── public/
│   ├── index.html
│   ├── app.js
│   ├── sw.js
│   └── style.css
│
├── routes/
│   └── api.js
│
├── services/
│   └── flowix.js
│
├── server.js
├── package.json
├── .env.example
└── README.md

Installation

Clone the repository:

git clone https://github.com/dani-techno/flowix-paylink-tutorial.git
cd flowix-paylink-tutorial

Install dependencies:

npm install

Create environment file:

cp .env.example .env

Start development server:

npm run dev

Or:

npm start

Environment Variables

Configure your Flowix credentials inside ".env".

FLOWIX_API_KEY=
FLOWIX_MERCHANT_ID=
FLOWIX_WEBHOOK_SECRET=
APP_PORT=3000

Learning Objectives

By following this tutorial, you will learn how to:

- Build a payment link application from scratch
- Create secure backend APIs with Express
- Integrate third-party payment systems
- Handle webhooks safely
- Implement invoice expiration logic
- Manage payment status synchronization
- Structure Node.js projects professionally

Notes

This project is intended for educational and learning purposes.

Before deploying to production, ensure that:

- Environment variables are secured
- HTTPS is enabled
- Webhook signatures are verified
- Input validation is implemented
- Rate limiting is configured

License

MIT License

---

Created with ❤️ by Flowix Technology