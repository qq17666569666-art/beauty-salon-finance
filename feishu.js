// 飞书多维表格数据管理模块
const https = require('https');

class FeishuBitable {
  constructor(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.token = null;
    this.tokenExpire = 0;
  }

  // 获取tenant_access_token
  async getToken() {
    // 如果token还有效，直接返回
    if (this.token && Date.now() < this.tokenExpire) {
      return this.token;
    }

    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret
      });

      const options = {
        hostname: 'open.feishu.cn',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.code === 0) {
              this.token = result.tenant_access_token;
              this.tokenExpire = Date.now() + (result.expire - 60) * 1000; // 提前60秒过期
              resolve(this.token);
            } else {
              reject(new Error(`获取token失败: ${result.msg}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // 发送请求封装
  async request(path, method = 'GET', data = null) {
    const token = await this.getToken();
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'open.feishu.cn',
        path,
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            resolve(result);
          } catch (e) {
            resolve(body);
          }
        });
      });

      req.on('error', reject);
      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    });
  }

  // 获取表格元数据
  async getAppInfo(appToken) {
    return this.request(`/open-apis/bitable/v1/apps/${appToken}`);
  }

  // 获取表格列表
  async getTables(appToken) {
    return this.request(`/open-apis/bitable/v1/apps/${appToken}/tables`);
  }

  // 创建表格
  async createTable(appToken, name, fields) {
    const data = {
      table: {
        name,
        fields: fields.map(f => ({
          field_name: f.name,
          type: f.type,
          ...(f.property && { property: f.property })
        }))
      }
    };
    return this.request(`/open-apis/bitable/v1/apps/${appToken}/tables`, 'POST', data);
  }

  // 获取记录列表
  async getRecords(appToken, tableId, options = {}) {
    let path = `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500`;
    if (options.viewId) path += `&view_id=${options.viewId}`;
    if (options.filter) path += `&filter=${encodeURIComponent(JSON.stringify(options.filter))}`;
    
    return this.request(path);
  }

  // 添加记录
  async addRecord(appToken, tableId, fields) {
    const data = { fields };
    return this.request(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, 'POST', data);
  }

  // 批量添加记录
  async batchAddRecords(appToken, tableId, records) {
    const data = {
      records: records.map(r => ({ fields: r }))
    };
    return this.request(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, 'POST', data);
  }

  // 更新记录
  async updateRecord(appToken, tableId, recordId, fields) {
    const data = { fields };
    return this.request(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, 'PUT', data);
  }

  // 删除记录
  async deleteRecord(appToken, tableId, recordId) {
    return this.request(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, 'DELETE');
  }
}

module.exports = FeishuBitable;
