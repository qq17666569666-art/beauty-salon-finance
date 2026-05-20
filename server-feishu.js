const express = require('express');
const fs = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const FeishuBitable = require('./feishu');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'beauty-salon-secret-key-2024';
const DATA_FILE = process.env.DATA_FILE || './data.json';

// 飞书配置
const FEISHU_APP_ID = 'cli_aa87c5b09bf91cdd';
const FEISHU_APP_SECRET = 'fBC5GCToNV1L51nNs8NgVvMHPnoZftyq';
const FEISHU_APP_TOKEN = 'NjQwbaNo7aWvs3skGlgctBBunBd';
const FEISHU_TRANSACTION_TABLE = 'tbl4EkMZ3oQwIPpN';  // 收集表

// 初始化飞书客户端
const feishu = new FeishuBitable(FEISHU_APP_ID, FEISHU_APP_SECRET);

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// 本地数据存储（仅用于员工账号）
class LocalDataStore {
  constructor() {
    this.data = { users: [] };
    this.load();
    this.init();
  }

  load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const content = fs.readFileSync(DATA_FILE, 'utf8');
        this.data = JSON.parse(content);
      }
    } catch (err) {
      console.error('加载数据失败:', err);
    }
  }

  save() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('保存数据失败:', err);
    }
  }

  init() {
    const bossExists = this.data.users.find(u => u.username === 'admin');
    if (!bossExists) {
      this.data.users.push({
        id: 1,
        username: 'admin',
        password: bcrypt.hashSync('admin123', 8),
        name: '老板',
        role: 'boss',
        created_at: new Date().toISOString()
      });
      this.save();
    }
  }

  getUserByUsername(username) {
    return this.data.users.find(u => u.username === username);
  }

  getUserById(id) {
    return this.data.users.find(u => u.id === id);
  }

  getAllStaff() {
    return this.data.users.filter(u => u.role === 'staff').map(u => ({
      id: u.id,
      username: u.username,
      name: u.name,
      created_at: u.created_at
    }));
  }

  addStaff(username, password, name) {
    if (this.data.users.find(u => u.username === username)) {
      throw new Error('用户名已存在');
    }
    const id = this.data.users.length > 0 ? Math.max(...this.data.users.map(u => u.id)) + 1 : 1;
    const staff = {
      id,
      username,
      password: bcrypt.hashSync(password, 8),
      name,
      role: 'staff',
      created_at: new Date().toISOString()
    };
    this.data.users.push(staff);
    this.save();
    return { id, message: '员工添加成功' };
  }

  deleteStaff(id) {
    const index = this.data.users.findIndex(u => u.id === id && u.role === 'staff');
    if (index === -1) return false;
    this.data.users.splice(index, 1);
    this.save();
    return true;
  }
}

const localDb = new LocalDataStore();

// 认证中间件
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: '未提供认证令牌' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: '令牌无效' });
    }
    req.user = user;
    next();
  });
};

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = localDb.getUserByUsername(username);
  
  if (!user) {
    return res.status(401).json({ message: '用户名或密码错误' });
  }

  const isValidPassword = bcrypt.compareSync(password, user.password);
  if (!isValidPassword) {
    return res.status(401).json({ message: '用户名或密码错误' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    }
  });
});

// 获取所有员工（仅老板）
app.get('/api/staff', authenticateToken, (req, res) => {
  if (req.user.role !== 'boss') {
    return res.status(403).json({ message: '无权访问' });
  }
  res.json(localDb.getAllStaff());
});

// 添加员工（仅老板）
app.post('/api/staff', authenticateToken, (req, res) => {
  if (req.user.role !== 'boss') {
    return res.status(403).json({ message: '无权访问' });
  }

  const { username, password, name } = req.body;
  try {
    const result = localDb.addStaff(username, password, name);
    res.json(result);
  } catch (err) {
    if (err.message === '用户名已存在') {
      return res.status(400).json({ message: '用户名已存在' });
    }
    return res.status(500).json({ message: '服务器错误' });
  }
});

// 删除员工（仅老板）
app.delete('/api/staff/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'boss') {
    return res.status(403).json({ message: '无权访问' });
  }

  const staffId = parseInt(req.params.id);
  const result = localDb.deleteStaff(staffId);
  
  if (!result) {
    return res.status(404).json({ message: '员工不存在' });
  }
  res.json({ message: '员工删除成功' });
});

// 添加收支记录（保存到飞书）
app.post('/api/transactions', authenticateToken, async (req, res) => {
  const { type, amount, category, description, store = '总部' } = req.body;
  const staffId = req.user.id;
  const staffName = req.user.name;

  try {
    // 构建飞书记录数据（适配你的表格字段）
    const recordData = {
      '日期 2': new Date().getTime(),
      '摘要': description || category,
      '收支': type === 'income' ? '收入' : '支出',
      '门店': store,
      '金额': amount.toString(),
      '分类': category,
      '月份': new Date().toISOString().slice(0, 7).replace('-', '')
    };

    const result = await feishu.addRecord(FEISHU_APP_TOKEN, FEISHU_TRANSACTION_TABLE, recordData);
    
    if (result.code === 0) {
      res.json({ 
        id: result.data.record.record_id, 
        message: '记录添加成功',
        feishuRecord: result.data.record
      });
    } else {
      console.error('飞书添加失败:', result);
      res.status(500).json({ message: '保存到飞书失败: ' + result.msg });
    }
  } catch (err) {
    console.error('添加记录错误:', err);
    res.status(500).json({ message: '服务器错误: ' + err.message });
  }
});

// 获取收支记录（从飞书读取）
app.get('/api/transactions', authenticateToken, async (req, res) => {
  const { startDate, endDate, type, store } = req.query;
  
  try {
    const options = {};
    
    // 构建筛选条件
    const conditions = [];
    if (startDate && endDate) {
      // 飞书日期筛选需要特殊处理
      const startTime = new Date(startDate).getTime();
      const endTime = new Date(endDate).getTime() + 86400000;
      // 这里简化处理，获取所有数据后在前端筛选
    }
    
    const result = await feishu.getRecords(FEISHU_APP_TOKEN, FEISHU_TRANSACTION_TABLE, options);
    
    if (result.code !== 0) {
      return res.status(500).json({ message: '获取飞书数据失败: ' + result.msg });
    }

    let records = result.data.items.map(item => ({
      id: item.record_id,
      record_id: item.record_id,
      ...item.fields,
      // 转换字段名以兼容前端
      type: item.fields['收支'] === '收入' ? 'income' : 'expense',
      amount: parseFloat(item.fields['金额']) || 0,
      category: item.fields['分类'] || item.fields['摘要'],
      description: item.fields['摘要'],
      store: item.fields['门店'],
      staff_name: '员工', // 飞书表中没有员工字段，用默认值
      created_at: item.fields['日期 2'] ? new Date(item.fields['日期 2']).toISOString() : new Date().toISOString()
    }));

    // 前端筛选
    if (startDate) {
      const start = new Date(startDate).getTime();
      records = records.filter(r => new Date(r.created_at).getTime() >= start);
    }
    if (endDate) {
      const end = new Date(endDate).getTime() + 86400000;
      records = records.filter(r => new Date(r.created_at).getTime() <= end);
    }
    if (type) {
      records = records.filter(r => r.type === type);
    }
    if (store) {
      records = records.filter(r => r.store === store);
    }

    res.json(records);
  } catch (err) {
    console.error('获取记录错误:', err);
    res.status(500).json({ message: '服务器错误: ' + err.message });
  }
});

// 获取统计信息
app.get('/api/statistics', authenticateToken, async (req, res) => {
  if (req.user.role !== 'boss') {
    return res.status(403).json({ message: '无权访问' });
  }

  const { startDate, endDate } = req.query;

  try {
    const result = await feishu.getRecords(FEISHU_APP_TOKEN, FEISHU_TRANSACTION_TABLE, { pageSize: 500 });
    
    if (result.code !== 0) {
      return res.status(500).json({ message: '获取飞书数据失败: ' + result.msg });
    }

    let transactions = result.data.items.map(item => ({
      type: item.fields['收支'] === '收入' ? 'income' : 'expense',
      amount: parseFloat(item.fields['金额']) || 0,
      category: item.fields['分类'] || '其他',
      store: item.fields['门店'] || '总部'
    }));

    // 日期筛选
    if (startDate || endDate) {
      // 简化处理，实际应该根据飞书日期字段筛选
    }

    const income = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
    const expense = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);

    // 按分类统计
    const categoryMap = {};
    transactions.forEach(t => {
      const key = `${t.category}-${t.type}`;
      if (!categoryMap[key]) {
        categoryMap[key] = { category: t.category, type: t.type, total: 0, count: 0 };
      }
      categoryMap[key].total += t.amount;
      categoryMap[key].count++;
    });

    // 按门店统计
    const storeMap = {};
    transactions.forEach(t => {
      if (!storeMap[t.store]) {
        storeMap[t.store] = { name: t.store, income: 0, expense: 0, record_count: 0 };
      }
      if (t.type === 'income') {
        storeMap[t.store].income += t.amount;
      } else {
        storeMap[t.store].expense += t.amount;
      }
      storeMap[t.store].record_count++;
    });

    res.json({
      income,
      expense,
      profit: income - expense,
      categories: Object.values(categoryMap).sort((a, b) => b.total - a.total),
      staffStats: Object.values(storeMap)
    });
  } catch (err) {
    console.error('获取统计错误:', err);
    res.status(500).json({ message: '服务器错误: ' + err.message });
  }
});

// 删除记录
app.delete('/api/transactions/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'boss') {
    return res.status(403).json({ message: '无权删除' });
  }

  const recordId = req.params.id;

  try {
    const result = await feishu.deleteRecord(FEISHU_APP_TOKEN, FEISHU_TRANSACTION_TABLE, recordId);
    if (result.code === 0) {
      res.json({ message: '记录删除成功' });
    } else {
      res.status(500).json({ message: '删除失败: ' + result.msg });
    }
  } catch (err) {
    res.status(500).json({ message: '服务器错误: ' + err.message });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`飞书表格: https://fi5sjimj7vi.feishu.cn/base/${FEISHU_APP_TOKEN}`);
  console.log(`默认老板账号: admin / admin123`);
});
